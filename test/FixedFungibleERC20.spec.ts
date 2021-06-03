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
      const bal0 = await tokens[0].balanceOf(wallet.address);
      const bal1 = await tokens[1].balanceOf(wallet.address);
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await fixed.mint(
        other.address,
        expandTo18Decimals(15),
        expandTo18Decimals(15),
        0,
        0
      )
      expect(await fixed.balanceOf(other.address)).to.eq(expandTo18Decimals(15))
      expect(await fixed.totalSupply()).to.eq(expandTo18Decimals(15))
      expect(bal0.sub(expandTo18Decimals(15)).sub(await tokens[0].balanceOf(wallet.address))).to.be.lte(1)     // Allow for a small rounding error (should be against the user)
      expect(bal1.sub(expandTo18Decimals(15)).sub(await tokens[1].balanceOf(wallet.address))).to.be.lte(1)
    })

    it('lop-sided liquidity', async () => {
      const bal0 = await tokens[0].balanceOf(wallet.address);
      const bal1 = await tokens[1].balanceOf(wallet.address);
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await fixed.mint(
        other.address,
        expandTo18Decimals(30),
        expandTo18Decimals(15),
        0,
        0
      )
      expect(await fixed.balanceOf(other.address)).to.eq(expandTo18Decimals(15))
      expect(bal0.sub(expandTo18Decimals(15)).sub(await tokens[0].balanceOf(wallet.address))).to.be.lte(1)     // Allow for a small rounding error (should be against the user)
      expect(bal1.sub(expandTo18Decimals(15)).sub(await tokens[1].balanceOf(wallet.address))).to.be.lte(1)
    })

    it('creates 2 positions', async () => {
      const bal0 = await tokens[0].balanceOf(wallet.address);
      const bal1 = await tokens[1].balanceOf(wallet.address);
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await fixed.mint(
        wallet.address,
        expandTo18Decimals(10),
        expandTo18Decimals(10),
        0,
        0
      )
      expect(await fixed.totalSupply()).to.eq(expandTo18Decimals(10))
      expect(await fixed.totalLiquidity()).to.eq(expandTo18Decimals(10))
      expect(await fixed.balanceOf(wallet.address)).to.eq(expandTo18Decimals(10))
      await fixed.mint(
        other.address,
        expandTo18Decimals(20),
        expandTo18Decimals(20),
        0,
        0
      )
      // Slight rounding errors
      expect(await fixed.totalSupply()).to.eq(expandTo18Decimals(30).add(1))
      expect(await fixed.totalLiquidity()).to.eq(expandTo18Decimals(30).add(1))
      expect(await fixed.balanceOf(wallet.address)).to.eq(expandTo18Decimals(10))
      expect(await fixed.balanceOf(other.address)).to.eq(expandTo18Decimals(20).add(1))
    })
  })

  describe('#burn', () => {
    beforeEach('create a position', async () => {
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )

      await fixed.mint(
        other.address,
        expandTo18Decimals(10),
        expandTo18Decimals(10),
        0,
        0
      )
    })

    it('burns the token', async () => {
      const bal0 = await tokens[0].balanceOf(other.address);
      const bal1 = await tokens[1].balanceOf(other.address);
      await fixed.connect(other).burn(expandTo18Decimals(10), 0, 0)
      const liquidity = await fixed.balanceOf(other.address)
      expect(liquidity).to.eq(0)
      expect(bal0.add(expandTo18Decimals(10)).sub(await tokens[0].balanceOf(other.address))).to.be.lte(1)     // Allow for a small rounding error (should be against the user)
      expect(bal1.add(expandTo18Decimals(10)).sub(await tokens[1].balanceOf(other.address))).to.be.lte(1)
    })
  })

  /*describe('#collect', () => {
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
  })*/

  describe('fees accounting', () => {
    beforeEach('create two positions', async () => {
      await fixed.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.LOW,
        encodePriceSqrt(1, 1)
      )
      // user 1 earns 25% of fees
      await fixed.mint(
        wallet.address,
        expandTo18Decimals(100),
        expandTo18Decimals(100),
        0,
        0
      )
      // user 2 earns 75% of fees
      await fixed.mint(
        other.address,
        expandTo18Decimals(300),
        expandTo18Decimals(300),
        0,
        0
      )
    })

    describe('10k of token0 fees collect', () => {
      beforeEach('swap for ~10k of fees', async () => {
        const swapAmount = expandTo18Decimals(20_000_000)
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
        expect(await fixed.totalSupply()).to.eq(expandTo18Decimals(400).add(21))
        expect(await fixed.totalLiquidity()).to.eq(expandTo18Decimals(400).add(21))
        await fixed.harvest()
        expect(await fixed.totalSupply()).to.eq(expandTo18Decimals(400).add(21))
        expect(await fixed.totalLiquidity()).to.eq(expandTo18Decimals(10_000 + 400).add(21))
      })

      /*it('actually collected', async () => {
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
      })*/
    })
  })
})
