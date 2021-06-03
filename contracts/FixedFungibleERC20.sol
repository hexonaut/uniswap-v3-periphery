// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import '@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol';
import '@uniswap/v3-core/contracts/libraries/FixedPoint128.sol';
import '@uniswap/v3-core/contracts/libraries/Position.sol';
import '@uniswap/v3-core/contracts/libraries/FullMath.sol';
import '@uniswap/v3-core/contracts/libraries/SafeCast.sol';

import './base/LiquidityManagement.sol';
import './base/PoolInitializer.sol';
import './interfaces/IFixedFungibleERC20.sol';
import './libraries/PoolAddress.sol';

/// @title Fixed Fungible ERC20
/// @notice Wraps Uniswap V3 positions in the ERC20 fungible token interface, re-invests profits
contract FixedFungibleERC20 is ERC20, LiquidityManagement, PoolInitializer, IUniswapV3SwapCallback {

    using LowGasSafeMath for uint256;
    using SafeCast for uint256;

    IUniswapV3Pool public immutable pool;
    ERC20 public immutable token0;
    ERC20 public immutable token1;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint160 public immutable sqrtRatioAX96;
    uint160 public immutable sqrtRatioBX96;
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
        require(_tickUpper > _tickLower, 'Ticks must be ordered');
        require(_token1 > _token0, 'Tokens must be ordered');

        poolKey = PoolAddress.PoolKey({token0: _token0, token1: _token1, fee: _fee});
        pool = IUniswapV3Pool(PoolAddress.computeAddress(_factory, poolKey));
        token0 = ERC20(_token0);
        token1 = ERC20(_token1);
        tickLower = _tickLower;
        tickUpper = _tickUpper;
        sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(_tickLower);
        sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(_tickUpper);
    }

    /// @dev Re-invest profit.
    modifier fees {
        (,,, uint128 tokensOwed0, uint128 tokensOwed1) = pool.positions(keccak256(abi.encodePacked(address(this), tickLower, tickUpper)));
        pool.collect(address(this), tickLower, tickUpper, tokensOwed0, tokensOwed1);

        // Swap one token for the other to maximize liquidity
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        if (sqrtPriceX96 <= sqrtRatioAX96) {
            // Price is above range - trade all of token1 for token0
            uint256 bal1 = token1.balanceOf(address(this));
            if (bal1 > 0) {
                pool.swap(
                    address(this),
                    false,
                    bal1.toInt256(),
                    TickMath.MAX_SQRT_RATIO - 1,    // FIXME: This can maybe be front-run, but amount should be many orders of magnitude below the liquidity so it's probably fine
                    ""
                );
            }
        } else if (sqrtPriceX96 < sqrtRatioBX96) {
            // Price is inside the range - calculate optimal combination assuming no slippage
            uint256 bal0 = token0.balanceOf(address(this));
            uint256 bal1 = token1.balanceOf(address(this));
            if (bal0 > 0 || bal1 > 0) {
                uint256 targetRatio = FullMath.mulDiv(sqrtPriceX96 - sqrtRatioAX96, FixedPoint96.Q96, sqrtRatioBX96 - sqrtRatioAX96);
                uint256 currentRatio = FullMath.mulDiv(bal1, FixedPoint96.Q96, bal0.add(bal1));
                if (currentRatio < targetRatio && bal0 > 0) {
                    // Trade token0 for token1
                    // TODO take price into account
                    pool.swap(
                        address(this),
                        true,
                        FullMath.mulDiv(targetRatio - currentRatio, bal0, 2 * FixedPoint96.Q96).toInt256(),
                        TickMath.MIN_SQRT_RATIO + 1,
                        ""
                    );
                } else if (currentRatio > targetRatio && bal1 > 0) {
                    // Trade token1 for token0
                    // TODO take price into account
                    pool.swap(
                        address(this),
                        false,
                        FullMath.mulDiv(currentRatio - targetRatio, bal1, 2 * FixedPoint96.Q96).toInt256(),
                        TickMath.MAX_SQRT_RATIO - 1,
                        ""
                    );
                }
            }
        } else {
            // Price is below range - trade all of token0 for token1
            uint256 bal0 = token0.balanceOf(address(this));
            if (bal0 > 0) {
                pool.swap(
                    address(this),
                    true,
                    bal0.toInt256(),
                    TickMath.MIN_SQRT_RATIO + 1,
                    ""
                );
            }
        }

        // compute the liquidity amount
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtRatioAX96,
            sqrtRatioBX96,
            token0.balanceOf(address(this)),
            token1.balanceOf(address(this))
        );

        if (liquidity > 0) {
            pool.mint(
                address(this),
                tickLower,
                tickUpper,
                liquidity,
                abi.encode(MintCallbackData({poolKey: poolKey, payer: address(this)}))
            );

            totalLiquidity = totalLiquidity.add(liquidity);
        }

        _;
    }

    /// @dev Mint new tokens in exchange for the underlying tokens.
    function mint(
        address recipient,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min
    ) external fees returns (uint256 amount) {
        // compute the liquidity amount
        uint128 liquidity;
        {
            (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

            liquidity = LiquidityAmounts.getLiquidityForAmounts(
                sqrtPriceX96,
                sqrtRatioAX96,
                sqrtRatioBX96,
                amount0Desired,
                amount1Desired
            );
        }

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
    ) external fees returns (uint256 amount0, uint256 amount1) {
        uint128 liquidity = toUint128(amount.mul(totalLiquidity) / totalSupply());   // Round against the user
        _burn(msg.sender, amount);
        (amount0, amount1) = pool.burn(tickLower, tickUpper, liquidity);
        totalLiquidity = totalLiquidity.sub(liquidity);

        require(amount0 >= amount0Min && amount1 >= amount1Min, 'Price slippage check');

        pool.collect(msg.sender, tickLower, tickUpper, toUint128(amount0), toUint128(amount1));
    }

    function harvest() external fees {
    }

    /// @notice Downcasts uint256 to uint128
    /// @param x The uint258 to be downcasted
    /// @return y The passed value, downcasted to uint128
    function toUint128(uint256 x) private pure returns (uint128 y) {
        require((y = uint128(x)) == x);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        CallbackValidation.verifyCallback(factory, poolKey);

        if (amount0Delta > 0) pay(address(token0), address(this), msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) pay(address(token1), address(this), msg.sender, uint256(amount1Delta));
    }

}
