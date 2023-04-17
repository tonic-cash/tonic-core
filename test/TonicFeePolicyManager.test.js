const { expect } = require('chai')
const { BN, ether, expectEvent, expectRevert } = require('@openzeppelin/test-helpers')
const TonicFeePolicyManager = artifacts.require('TonicFeePolicyManager')
const ERC20Token = artifacts.require('ERC20Token')

contract('TonicFeePolicyManager', function (accounts) {
  const [owner, recipient, treasury, newTreasury] = accounts
  let tonicFeePolicyManager

  beforeEach(async function () {
    tonicFeePolicyManager = await TonicFeePolicyManager.new('1', '100', treasury, { from: owner })
  })

  describe('Deployment', function () {
    it('should set initial state correctly', async function () {
      expect(await tonicFeePolicyManager.feeNumerator()).to.be.bignumber.equal(new BN('1'))
      expect(await tonicFeePolicyManager.feeDenominator()).to.be.bignumber.equal(new BN('100'))
      expect(await tonicFeePolicyManager.treasury()).to.equal(treasury)
    })
  })

  describe('setFeePolicy', function () {
    it('should update fee policy and emit an event', async function () {
      const receipt = await tonicFeePolicyManager.setFeePolicy('2', '100', { from: owner })

      expect(await tonicFeePolicyManager.feeNumerator()).to.be.bignumber.equal(new BN('2'))
      expect(await tonicFeePolicyManager.feeDenominator()).to.be.bignumber.equal(new BN('100'))
      expectEvent(receipt, 'FeePolicyUpdated', { feeNumerator: new BN('2'), feeDenominator: new BN('100') })
    })

    it('should revert if numerator is greater than denominator', async function () {
      await expectRevert(
        tonicFeePolicyManager.setFeePolicy('101', '100', { from: owner }),
        'numerator should be less than or equal to denominator',
      )
    })
  })

  describe('setTreasuryAddress', function () {
    it('should update treasury address and emit an event', async function () {
      const receipt = await tonicFeePolicyManager.setTreasuryAddress(newTreasury, { from: owner })

      expect(await tonicFeePolicyManager.treasury()).to.equal(newTreasury)
      expectEvent(receipt, 'TreasuryAddressUpdated', { treasury: newTreasury })
    })

    it('should revert if treasury address is zero address', async function () {
      await expectRevert(
        tonicFeePolicyManager.setTreasuryAddress('0x0000000000000000000000000000000000000000', {
          from: owner,
        }),
        'treasury address should not be zero address',
      )
    })
  })

  describe('transfer', function () {
    beforeEach(async function () {
      await web3.eth.sendTransaction({ from: owner, to: tonicFeePolicyManager.address, value: ether('1') })
    })

    it('should transfer ether to recipient', async function () {
      const initialBalance = await web3.eth.getBalance(recipient)
      const amountToTransfer = ether('0.5')

      await tonicFeePolicyManager.methods['transfer(address,uint256)'](
        recipient,
        amountToTransfer.toString(),
        { from: owner },
      )

      const finalBalance = await web3.eth.getBalance(recipient)
      expect(new BN(finalBalance)).to.be.bignumber.equal(new BN(initialBalance).add(amountToTransfer))
    })

    it('should revert if not called by owner', async function () {
      await expectRevert(
        tonicFeePolicyManager.methods['transfer(address,uint256)'](recipient, ether('0.5').toString(), {
          from: recipient,
        }),
        'Ownable: caller is not the owner',
      )
    })
  })

  describe('transfer tokens', function () {
    let token

    beforeEach(async function () {
      token = await ERC20Token.new('Example Token', 'EXT', 18, ether('1000'), owner, { from: owner })
      await token.transfer(tonicFeePolicyManager.address, ether('1000').toString(), { from: owner })
    })

    it('should transfer tokens to recipient', async function () {
      const initialBalance = await token.balanceOf(recipient)
      const amountToTransfer = ether('500')

      await tonicFeePolicyManager.methods['transfer(address,address,uint256)'](
        recipient,
        token.address,
        amountToTransfer.toString(),
        { from: owner },
      )

      const finalBalance = await token.balanceOf(recipient)
      expect(finalBalance).to.be.bignumber.equal(initialBalance.add(amountToTransfer))
    })

    it('should revert if not called by owner', async function () {
      await expectRevert(
        tonicFeePolicyManager.methods['transfer(address,address,uint256)'](
          recipient,
          token.address,
          ether('500').toString(),
          { from: recipient },
        ),
        'Ownable: caller is not the owner',
      )
    })
  })
})
