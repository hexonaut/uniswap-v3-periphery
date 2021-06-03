// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.7.5;
pragma abicoder v2;

import '@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol';

/// @title Fixed Fungible ERC20
/// @notice Wraps Uniswap V3 positions in the ERC20 fungible token interface, re-invests profits
interface IFixedFungibleERC20 is IUniswapV3SwapCallback {
}
