// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import '@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol';
import '@uniswap/v3-core/contracts/libraries/FixedPoint128.sol';
import '@uniswap/v3-core/contracts/libraries/Position.sol';
import '@uniswap/v3-core/contracts/libraries/FullMath.sol';

import './base/LiquidityManagement.sol';
import './base/PoolInitializer.sol';
import './libraries/PoolAddress.sol';

/// @title Fixed Fungible ERC20
/// @notice Wraps Uniswap V3 positions in the ERC20 fungible token interface, re-invests profits
contract FixedFungibleERC20 is ERC20, LiquidityManagement, PoolInitializer {

    using LowGasSafeMath for uint256;

    IUniswapV3Pool public immutable pool;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    PoolAddress.PoolKey public poolKey;

    uint256 public total0;
    uint256 public total1;

    constructor(
        address _factory,
        address _WETH9,
        address _token0,
        address _token1,
        uint24 _fee,
        int24 _tickLower,
        int24 _tickUpper
    )
        ERC20('Uniswap V3 Fixed', 'UNI-V3-FIXED')
        PeripheryImmutableState(_factory, _WETH9)
    {
        poolKey = PoolAddress.PoolKey({token0: _token0, token1: _token1, fee: _fee});
        pool = IUniswapV3Pool(PoolAddress.computeAddress(_factory, poolKey));
        tickLower = _tickLower;
        tickUpper = _tickUpper;
    }

    /// @dev Mint new tokens in exchange for the underlying tokens.
    function mint(
        address recipient,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min
    ) external returns (uint128 liquidity) {
        // compute the liquidity amount
        {
            (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
            uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
            uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);

            liquidity = LiquidityAmounts.getLiquidityForAmounts(
                sqrtPriceX96,
                sqrtRatioAX96,
                sqrtRatioBX96,
                amount0Desired,
                amount1Desired
            );
        }

        (uint256 amount0, uint256 amount1) = pool.mint(
            recipient,
            tickLower,
            tickUpper,
            liquidity,
            abi.encode(MintCallbackData({poolKey: poolKey, payer: msg.sender}))
        );

        total0 = total0.add(amount0);
        total1 = total1.add(amount1);

        _mint(recipient, liquidity);

        require(amount0 >= amount0Min && amount1 >= amount1Min, 'Price slippage check');
    }

    /// @dev Re-invest profit.
    function reap() external {
        Position.Info memory position = pool.positions(Position.get(address(this), tickLower, tickUpper));
        pool.collect(address(this), tickLower, tickUpper, position.tokensOwed0, position.tokensOwed1);
    }

}
