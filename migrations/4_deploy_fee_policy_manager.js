/* global artifacts */
const TonicFeePolicyManager = artifacts.require('TonicFeePolicyManager')

const feeNumerator = 3
const feeDenominator = 100
const treasuryAddress = '0x0000000000000000000000000000000000000000'

module.exports = function (deployer) {
  return deployer.then(async () => {
    const tonicFeePolicyManager = await deployer.deploy(
      TonicFeePolicyManager,
      feeNumerator,
      feeDenominator,
      treasuryAddress,
    )
    console.log('TonicFeePolicyManager address', tonicFeePolicyManager.address)
  })
}
