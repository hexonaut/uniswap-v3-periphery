import { BigNumberish, constants } from 'ethers'
import { waffle, ethers } from 'hardhat'

import { Fixture } from 'ethereum-waffle'
import {
  TestPositionNFTOwner,
  FixedFungibleERC20,
  TestERC20,
  IWETH9,
  IUniswapV3Factory,
  SwapRouter,
} from '../typechain'
import completeFixture from './shared/completeFixture'
import { computePoolAddress } from './shared/computePoolAddress'
import { FeeAmount, MaxUint128, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { expect } from './shared/expect'
import getPermitNFTSignature from './shared/getPermitNFTSignature'
import { encodePath } from './shared/path'
import poolAtAddress from './shared/poolAtAddress'
import snapshotGasCost from './shared/snapshotGasCost'
import { getMaxTick, getMinTick } from './shared/ticks'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { sortedTokens } from './shared/tokenSort'
import { extractJSONFromURI } from './shared/extractJSONFromURI'

import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'

describe('FixedFungibleERC20', () => {
  const wallets = waffle.provider.getWallets()
  const [wallet, other] = wallets

  const fixedFixture: Fixture<{
    fixed: FixedFungibleERC20
    factory: IUniswapV3Factory
    tokens: [TestERC20, TestERC20, TestERC20]
    weth9: IWETH9
    router: SwapRouter
  }> = async (wallets, provider) => {
    const { weth9, factory, tokens, fixed, router } = await completeFixture(wallets, provider)

    // approve & fund wallets
    for (const token of tokens) {
      await token.approve(fixed.address, constants.MaxUint256)
      await token.connect(other).approve(fixed.address, constants.MaxUint256)
      await token.transfer(other.address, expandTo18Decimals(1_000_000))
    }

    return {
      fixed,
      factory,
      tokens,
      weth9,
      router,
    }
  }

  let factory: IUniswapV3Factory
  let fixed: FixedFungibleERC20
  let tokens: [TestERC20, TestERC20, TestERC20]
  let weth9: IWETH9
  let router: SwapRouter

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    loadFixture = waffle.createFixtureLoader(wallets)
  })

  beforeEach('load fixture', async () => {
    ;({ fixed, factory, tokens, weth9, router } = await loadFixture(fixedFixture))
  })

  describe('#createAndInitializePoolIfNecessary', () => {
    it('creates the pool at the expected address', async () => {
      const expectedAddress = computePoolAddress(
        factory.address,
        [tokens[0].address, tokens[1].address],
        FeeAmount.LOW
      )
      const code = await wallet.provider.getCode(expectedAddress)
      expect(code).to.eq('0x')
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )
      const codeAfter = await wallet.provider.getCode(expectedAddress)
      expect(codeAfter).to.not.eq('0x')
      expect(await fixed.pool()).to.eq(expectedAddress)
    })

    it('is payable', async () => {
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1),
        { value: 1 }
      )
    })

    it('works if pool is created but not initialized', async () => {
      const expectedAddress = computePoolAddress(
        factory.address,
        [tokens[0].address, tokens[1].address],
        FeeAmount.LOW
      )
      await factory.createPool(tokens[0].address, tokens[1].address, FeeAmount.LOW)
      const code = await wallet.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(2, 1)
      )
    })

    it('works if pool is created and initialized', async () => {
      const expectedAddress = computePoolAddress(
        factory.address,
        [tokens[0].address, tokens[1].address],
        FeeAmount.LOW
      )
      await factory.createPool(tokens[0].address, tokens[1].address, FeeAmount.LOW)
      const pool = new ethers.Contract(expectedAddress, IUniswapV3PoolABI, wallet)

      await pool.initialize(encodePriceSqrt(3, 1))
      const code = await wallet.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(4, 1)
      )
    })
  })

  describe('#mint', () => {
    it('fails if pool does not exist', async () => {
      await expect(
        fixed.mint(
          wallet.address,
          100,
          100,
          0,
          0
        )
      ).to.be.reverted
    })

    it('fails if cannot transfer', async () => {
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )
      await tokens[0].approve(fixed.address, 0)
      await expect(
        fixed.mint(
          wallet.address,
          100,
          100,
          0,
          0
        )
      ).to.be.revertedWith('STF')
    })

    it('creates a token', async () => {
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await fixed.mint(
        other.address,
        15,
        15,
        0,
        0
      )
      expect(await fixed.balanceOf(other.address)).to.eq(15)
    })

    /*it('emits an event')

    it('gas first mint for pool', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await snapshotGasCost(
        nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
          fee: FeeAmount.LOW,
          recipient: wallet.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })

    it('gas first mint for pool using eth with zero refund', async () => {
      const [token0, token1] = sortedTokens(weth9, tokens[0])
      await nft.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await snapshotGasCost(
        nft.multicall(
          [
            nft.interface.encodeFunctionData('mint', [
              {
                token0: token0.address,
                token1: token1.address,
                tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
                tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
                fee: FeeAmount.LOW,
                recipient: wallet.address,
                amount0Desired: 100,
                amount1Desired: 100,
                amount0Min: 0,
                amount1Min: 0,
                deadline: 10,
              },
            ]),
            nft.interface.encodeFunctionData('refundETH'),
          ],
          { value: 100 }
        )
      )
    })

    it('gas first mint for pool using eth with non-zero refund', async () => {
      const [token0, token1] = sortedTokens(weth9, tokens[0])
      await nft.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await snapshotGasCost(
        nft.multicall(
          [
            nft.interface.encodeFunctionData('mint', [
              {
                token0: token0.address,
                token1: token1.address,
                tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
                tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
                fee: FeeAmount.LOW,
                recipient: wallet.address,
                amount0Desired: 100,
                amount1Desired: 100,
                amount0Min: 0,
                amount1Min: 0,
                deadline: 10,
              },
            ]),
            nft.interface.encodeFunctionData('refundETH'),
          ],
          { value: 1000 }
        )
      )
    })

    it('gas mint on same ticks', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        fee: FeeAmount.LOW,
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      await snapshotGasCost(
        nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
          fee: FeeAmount.LOW,
          recipient: wallet.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })

    it('gas mint for same pool, different ticks', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        fee: FeeAmount.LOW,
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      await snapshotGasCost(
        nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]) + TICK_SPACINGS[FeeAmount.LOW],
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]) - TICK_SPACINGS[FeeAmount.LOW],
          fee: FeeAmount.LOW,
          recipient: wallet.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })*/
  })

  /*describe('#increaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        fee: FeeAmount.LOW,
        recipient: other.address,
        amount0Desired: 1000,
        amount1Desired: 1000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('increases position liquidity', async () => {
      await nft.increaseLiquidity({
        tokenId: tokenId,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(1100)
    })

    it('emits an event')

    it('can be paid with ETH', async () => {
      const [token0, token1] = sortedTokens(tokens[0], weth9)

      const tokenId = 1

      await nft.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      const mintData = nft.interface.encodeFunctionData('mint', [
        {
          token0: token0.address,
          token1: token1.address,
          fee: FeeAmount.LOW,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
          recipient: other.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        },
      ])
      const refundETHData = nft.interface.encodeFunctionData('unwrapWETH9', [0, other.address])
      await nft.multicall([mintData, refundETHData], { value: expandTo18Decimals(1) })

      const increaseLiquidityData = nft.interface.encodeFunctionData('increaseLiquidity', [
        {
          tokenId: tokenId,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        },
      ])
      await nft.multicall([increaseLiquidityData, refundETHData], { value: expandTo18Decimals(1) })
    })

    it('gas', async () => {
      await snapshotGasCost(
        nft.increaseLiquidity({
          tokenId: tokenId,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      )
    })
  })

  describe('#decreaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        fee: FeeAmount.LOW,
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('fails if past deadline', async () => {
      await nft.setTime(2)
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.revertedWith('Transaction too old')
    })

    it('cannot be called by other addresses', async () => {
      await expect(
        nft.decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.revertedWith('Not approved')
    })

    it('decreases position liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(75)
    })

    it('is payable', async () => {
      await nft
        .connect(other)
        .decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 }, { value: 1 })
    })

    it('accounts for tokens owed', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { tokensOwed0, tokensOwed1 } = await nft.positions(tokenId)
      expect(tokensOwed0).to.eq(24)
      expect(tokensOwed1).to.eq(24)
    })

    it('can decrease for all the liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(0)
    })

    it('cannot decrease for more than all the liquidity', async () => {
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 101, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted
    })

    it('cannot decrease for more than the liquidity of the nft position', async () => {
      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        fee: FeeAmount.LOW,
        recipient: other.address,
        amount0Desired: 200,
        amount1Desired: 200,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 101, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted
    })

    it('gas partial decrease', async () => {
      await snapshotGasCost(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      )
    })

    it('gas complete decrease', async () => {
      await snapshotGasCost(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      )
    })
  })

  describe('#collect', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.LOW,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('cannot be called by other addresses', async () => {
      await expect(
        nft.collect({
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      ).to.be.revertedWith('Not approved')
    })

    it('cannot be called with 0 for both amounts', async () => {
      await expect(
        nft.connect(other).collect({
          tokenId,
          recipient: wallet.address,
          amount0Max: 0,
          amount1Max: 0,
        })
      ).to.be.reverted
    })

    it('no op if no tokens are owed', async () => {
      await expect(
        nft.connect(other).collect({
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      )
        .to.not.emit(tokens[0], 'Transfer')
        .to.not.emit(tokens[1], 'Transfer')
    })

    it('transfers tokens owed from burn', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const poolAddress = computePoolAddress(factory.address, [tokens[0].address, tokens[1].address], FeeAmount.LOW)
      await expect(
        nft.connect(other).collect({
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      )
        .to.emit(tokens[0], 'Transfer')
        .withArgs(poolAddress, wallet.address, 49)
        .to.emit(tokens[1], 'Transfer')
        .withArgs(poolAddress, wallet.address, 49)
    })

    it('gas transfers both', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        nft.connect(other).collect({
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      )
    })

    it('gas transfers token0 only', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        nft.connect(other).collect({
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: 0,
        })
      )
    })

    it('gas transfers token1 only', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        nft.connect(other).collect({
          tokenId,
          recipient: wallet.address,
          amount0Max: 0,
          amount1Max: MaxUint128,
        })
      )
    })
  })

  describe('#burn', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.LOW,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('cannot be called by other addresses', async () => {
      await expect(nft.burn(tokenId)).to.be.revertedWith('Not approved')
    })

    it('cannot be called while there is still liquidity', async () => {
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('cannot be called while there is still partial liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('cannot be called while there is still tokens owed', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('deletes the token', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await nft.connect(other).collect({
        tokenId,
        recipient: wallet.address,
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
      })
      await nft.connect(other).burn(tokenId)
      await expect(nft.positions(tokenId)).to.be.revertedWith('Invalid token ID')
    })

    it('gas', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await nft.connect(other).collect({
        tokenId,
        recipient: wallet.address,
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
      })
      await snapshotGasCost(nft.connect(other).burn(tokenId))
    })
  })

  describe('#transferFrom', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.LOW,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('can only be called by authorized or owner', async () => {
      await expect(nft.transferFrom(other.address, wallet.address, tokenId)).to.be.revertedWith(
        'ERC721: transfer caller is not owner nor approved'
      )
    })

    it('changes the owner', async () => {
      await nft.connect(other).transferFrom(other.address, wallet.address, tokenId)
      expect(await nft.ownerOf(tokenId)).to.eq(wallet.address)
    })

    it('removes existing approval', async () => {
      await nft.connect(other).approve(wallet.address, tokenId)
      expect(await nft.getApproved(tokenId)).to.eq(wallet.address)
      await nft.transferFrom(other.address, wallet.address, tokenId)
      expect(await nft.getApproved(tokenId)).to.eq(constants.AddressZero)
    })

    it('gas', async () => {
      await snapshotGasCost(nft.connect(other).transferFrom(other.address, wallet.address, tokenId))
    })

    it('gas comes from approved', async () => {
      await nft.connect(other).approve(wallet.address, tokenId)
      await snapshotGasCost(nft.transferFrom(other.address, wallet.address, tokenId))
    })
  })

  describe('#permit', () => {
    it('emits an event')

    describe('owned by eoa', () => {
      const tokenId = 1
      beforeEach('create a position', async () => {
        await nft.createAndInitializePoolIfNecessary(
          tokens[0].address,
          tokens[1].address,
          FeeAmount.LOW,
          encodePriceSqrt(1, 1)
        )

        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          fee: FeeAmount.LOW,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
          recipient: other.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        expect((await nft.positions(tokenId)).nonce).to.eq(1)
        expect((await nft.positions(tokenId)).operator).to.eq(wallet.address)
      })

      it('cannot be called twice with the same signature', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.reverted
      })

      it('fails with invalid signature', async () => {
        const { v, r, s } = await getPermitNFTSignature(wallet, nft, wallet.address, tokenId, 1)
        await expect(nft.permit(wallet.address, tokenId, 1, v + 3, r, s)).to.be.revertedWith('Invalid signature')
      })

      it('fails with signature not from owner', async () => {
        const { v, r, s } = await getPermitNFTSignature(wallet, nft, wallet.address, tokenId, 1)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Unauthorized')
      })

      it('fails with expired signature', async () => {
        await nft.setTime(2)
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Permit expired')
      })

      it('gas', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await snapshotGasCost(nft.permit(wallet.address, tokenId, 1, v, r, s))
      })
    })
    describe('owned by verifying contract', () => {
      const tokenId = 1
      let testPositionNFTOwner: TestPositionNFTOwner

      beforeEach('deploy test owner and create a position', async () => {
        testPositionNFTOwner = (await (
          await ethers.getContractFactory('TestPositionNFTOwner')
        ).deploy()) as TestPositionNFTOwner

        await nft.createAndInitializePoolIfNecessary(
          tokens[0].address,
          tokens[1].address,
          FeeAmount.LOW,
          encodePriceSqrt(1, 1)
        )

        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          fee: FeeAmount.LOW,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
          recipient: testPositionNFTOwner.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        expect((await nft.positions(tokenId)).nonce).to.eq(1)
        expect((await nft.positions(tokenId)).operator).to.eq(wallet.address)
      })

      it('fails if owner contract is owned by different address', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(wallet.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Unauthorized')
      })

      it('fails with signature not from owner', async () => {
        const { v, r, s } = await getPermitNFTSignature(wallet, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Unauthorized')
      })

      it('fails with expired signature', async () => {
        await nft.setTime(2)
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Permit expired')
      })

      it('gas', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await snapshotGasCost(nft.permit(wallet.address, tokenId, 1, v, r, s))
      })
    })
  })

  describe('multicall exit', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.LOW,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    async function exit({
      nft,
      liquidity,
      tokenId,
      amount0Min,
      amount1Min,
      recipient,
    }: {
      nft: MockTimeNonfungiblePositionManager
      tokenId: BigNumberish
      liquidity: BigNumberish
      amount0Min: BigNumberish
      amount1Min: BigNumberish
      recipient: string
    }) {
      const decreaseLiquidityData = nft.interface.encodeFunctionData('decreaseLiquidity', [
        { tokenId, liquidity, amount0Min, amount1Min, deadline: 1 },
      ])
      const collectData = nft.interface.encodeFunctionData('collect', [
        {
          tokenId,
          recipient,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        },
      ])
      const burnData = nft.interface.encodeFunctionData('burn', [tokenId])

      return nft.multicall([decreaseLiquidityData, collectData, burnData])
    }

    it('executes all the actions', async () => {
      const pool = poolAtAddress(
        computePoolAddress(factory.address, [tokens[0].address, tokens[1].address], FeeAmount.LOW),
        wallet
      )
      await expect(
        exit({
          nft: nft.connect(other),
          tokenId,
          liquidity: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: wallet.address,
        })
      )
        .to.emit(pool, 'Burn')
        .to.emit(pool, 'Collect')
    })

    it('gas', async () => {
      await snapshotGasCost(
        exit({
          nft: nft.connect(other),
          tokenId,
          liquidity: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: wallet.address,
        })
      )
    })
  })

  describe('#tokenURI', async () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.LOW,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('reverts for invalid token id', async () => {
      await expect(nft.tokenURI(tokenId + 1)).to.be.reverted
    })

    it('returns a data URI with correct mime type', async () => {
      expect(await nft.tokenURI(tokenId)).to.match(/data:application\/json;base64,.+/)
    })

    it('content is valid JSON and structure', async () => {
      const content = extractJSONFromURI(await nft.tokenURI(tokenId))
      expect(content).to.haveOwnProperty('name').is.a('string')
      expect(content).to.haveOwnProperty('description').is.a('string')
      expect(content).to.haveOwnProperty('image').is.a('string')
    })
  })

  describe('fees accounting', () => {
    beforeEach('create two positions', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )
      // nft 1 earns 25% of fees
      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.LOW,
        tickLower: getMinTick(FeeAmount.LOW),
        tickUpper: getMaxTick(FeeAmount.LOW),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
        recipient: wallet.address,
      })
      // nft 2 earns 75% of fees
      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.LOW,
        tickLower: getMinTick(FeeAmount.LOW),
        tickUpper: getMaxTick(FeeAmount.LOW),

        amount0Desired: 300,
        amount1Desired: 300,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
        recipient: wallet.address,
      })
    })

    describe('10k of token0 fees collect', () => {
      beforeEach('swap for ~10k of fees', async () => {
        const swapAmount = 3_333_333
        await tokens[0].approve(router.address, swapAmount)
        await router.exactInput({
          recipient: wallet.address,
          deadline: 1,
          path: encodePath([tokens[0].address, tokens[1].address], [FeeAmount.LOW]),
          amountIn: swapAmount,
          amountOutMinimum: 0,
        })
      })
      it('expected amounts', async () => {
        const { amount0: nft1Amount0, amount1: nft1Amount1 } = await nft.callStatic.collect({
          tokenId: 1,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
        const { amount0: nft2Amount0, amount1: nft2Amount1 } = await nft.callStatic.collect({
          tokenId: 2,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
        expect(nft1Amount0).to.eq(2501)
        expect(nft1Amount1).to.eq(0)
        expect(nft2Amount0).to.eq(7503)
        expect(nft2Amount1).to.eq(0)
      })

      it('actually collected', async () => {
        const poolAddress = computePoolAddress(
          factory.address,
          [tokens[0].address, tokens[1].address],
          FeeAmount.LOW
        )

        await expect(
          nft.collect({
            tokenId: 1,
            recipient: wallet.address,
            amount0Max: MaxUint128,
            amount1Max: MaxUint128,
          })
        )
          .to.emit(tokens[0], 'Transfer')
          .withArgs(poolAddress, wallet.address, 2501)
          .to.not.emit(tokens[1], 'Transfer')
        await expect(
          nft.collect({
            tokenId: 2,
            recipient: wallet.address,
            amount0Max: MaxUint128,
            amount1Max: MaxUint128,
          })
        )
          .to.emit(tokens[0], 'Transfer')
          .withArgs(poolAddress, wallet.address, 7503)
          .to.not.emit(tokens[1], 'Transfer')
      })
    })
  })*/
})
