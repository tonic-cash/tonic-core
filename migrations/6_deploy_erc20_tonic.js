/* global artifacts */
require('dotenv').config({ path: '../.env' })
const ERC20Tonic = artifacts.require('ERC20Tonic')
const ERC20Token = artifacts.require('ERC20Token')
const Verifier = artifacts.require('Verifier')
const Hasher = artifacts.require('Hasher')
const TonicFeePolicyManager = artifacts.require('TonicFeePolicyManager')

const MERKLE_TREE_HEIGHT = 20
const ERC20_AMOUNT = '1000000000000000000'

module.exports = function (deployer, _network, accounts) {
  return deployer.then(async () => {
    const verifier = await Verifier.deployed()
    const hasher = await Hasher.deployed()
    const feePolicyManager = await TonicFeePolicyManager.deployed()

    const token = await deployer.deploy(ERC20Token, 'Test', 'TEST', 18, 10_000_000, accounts[0])

    const tonic = await deployer.deploy(
      ERC20Tonic,
      verifier.address,
      hasher.address,
      ERC20_AMOUNT,
      MERKLE_TREE_HEIGHT,
      token.address,
      feePolicyManager.address,
    )
    console.log('ERC20Tonic address', tonic.address)
  })
}
