import { BigNumberish, utils } from 'ethers'

export function computePositionHash(address: string, tickLower: BigNumberish, tickUpper: BigNumberish): string {
  return utils.solidityKeccak256(
    ['address', 'int24', 'int24'],
    [address, tickLower, tickUpper]
  )
}
