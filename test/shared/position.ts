import { BigNumberish, utils } from 'ethers'

export function computePositionHash(address: string, tickLower: BigNumberish, tickUpper: BigNumberish): string {
  const argsEncoded = utils.defaultAbiCoder.encode(
    ['address', 'int24', 'int24'],
    [address, tickLower, tickUpper]
  )
  return utils.keccak256(argsEncoded)
}
