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
    ERC20 public immutable token0;
    ERC20 public immutable token1;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    PoolAddress.PoolKey public poolKey;

    /// @dev Equal to totalSupply + fees.
    uint256 public totalLiquidity;

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
        token0 = ERC20(_token0);
        token1 = ERC20(_token1);
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
    ) external returns (uint256 amount) {
        // compute the liquidity amount
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtRatioAX96,
            sqrtRatioBX96,
            amount0Desired,
            amount1Desired
        );

        (uint256 amount0, uint256 amount1) = pool.mint(
            address(this),
            tickLower,
            tickUpper,
            liquidity,
            abi.encode(MintCallbackData({poolKey: poolKey, payer: msg.sender}))
        );

        uint256 _totalSupply = totalSupply();
        if (_totalSupply != 0) amount = uint256(liquidity).mul(totalSupply()) / totalLiquidity;   // Round against the user
        else amount = uint256(liquidity);
        totalLiquidity = totalLiquidity.add(liquidity);
        _mint(recipient, amount);

        require(amount0 >= amount0Min && amount1 >= amount1Min, 'Price slippage check');
    }

    /// @dev Burn tokens
    function burn(
        uint256 amount,
        uint256 amount0Min,
        uint256 amount1Min
    ) external returns (uint256 amount0, uint256 amount1) {
        uint128 liquidity = toUint128(amount.mul(totalLiquidity) / totalSupply());   // Round against the user
        _burn(msg.sender, amount);
        (amount0, amount1) = pool.burn(tickLower, tickUpper, liquidity);
        totalLiquidity = totalLiquidity.sub(liquidity);

        require(amount0 >= amount0Min && amount1 >= amount1Min, 'Price slippage check');

        pool.collect(msg.sender, tickLower, tickUpper, toUint128(amount0), toUint128(amount1));
    }

    /// @dev Re-invest profit.
    function harvest() external returns (uint128 liquidity) {
        (,,, uint128 tokensOwed0, uint128 tokensOwed1) = pool.positions(keccak256(abi.encodePacked(address(this), tickLower, tickUpper)));
        pool.collect(address(this), tickLower, tickUpper, tokensOwed0, tokensOwed1);

        // Check the balance as there may be more tokens sitting in the contract
        uint256 balance0 = token0.balanceOf(address(this));
        uint256 balance1 = token1.balanceOf(address(this));

        // compute the liquidity amount
        {
            (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
            uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
            uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);

            liquidity = LiquidityAmounts.getLiquidityForAmounts(
                sqrtPriceX96,
                sqrtRatioAX96,
                sqrtRatioBX96,
                balance0,
                balance1
            );
        }

        // TODO - swap token0 to token1 if liquidity is constrained by token1 (and vice versa) ??

        pool.mint(
            address(this),
            tickLower,
            tickUpper,
            liquidity,
            abi.encode(MintCallbackData({poolKey: poolKey, payer: address(this)}))
        );

        totalLiquidity = totalLiquidity.add(liquidity);
    }

    /// @notice Downcasts uint256 to uint128
    /// @param x The uint258 to be downcasted
    /// @return y The passed value, downcasted to uint128
    function toUint128(uint256 x) private pure returns (uint128 y) {
        require((y = uint128(x)) == x);
    }

}
