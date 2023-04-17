/* global artifacts */
const ETHTonic = artifacts.require('ETHTonic')
const Verifier = artifacts.require('Verifier')
const Hasher = artifacts.require('Hasher')
const TonicFeePolicyManager = artifacts.require('TonicFeePolicyManager')

const MERKLE_TREE_HEIGHT = 20
const ETH_AMOUNT = '1000000000000000000'

module.exports = function (deployer) {
  return deployer.then(async () => {
    const verifier = await Verifier.deployed()
    const hasher = await Hasher.deployed()
    const feePolicyManager = await TonicFeePolicyManager.deployed()

    const tonic = await deployer.deploy(
      ETHTonic,
      verifier.address,
      hasher.address,
      ETH_AMOUNT,
      MERKLE_TREE_HEIGHT,
      feePolicyManager.address,
    )
    console.log(`ETHTonic address`, tonic.address)
  })
}
