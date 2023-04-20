import { ethers } from 'hardhat'

export const takeSnapshot = async () => {
  return ethers.provider.send('evm_snapshot', [])
}

export const revertToSnapshot = async (snapshot: any) => {
  return ethers.provider.send('evm_revert', [snapshot])
}
