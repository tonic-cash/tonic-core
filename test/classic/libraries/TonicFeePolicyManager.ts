import { BigNumber } from '@ethersproject/bignumber'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { ERC20Token, TonicFeePolicyManager } from '@/typechain-types'

describe('TonicFeePolicyManager', () => {
  let owner: SignerWithAddress
  let recipient: SignerWithAddress
  let treasury: SignerWithAddress
  let newTreasury: SignerWithAddress
  let tonicFeePolicyManager: TonicFeePolicyManager

  beforeEach(async () => {
    ;[owner, recipient, treasury, newTreasury] = await ethers.getSigners()
    const tonicFeePolicyManagerFactory = await ethers.getContractFactory('TonicFeePolicyManager')
    tonicFeePolicyManager = await tonicFeePolicyManagerFactory
      .connect(owner)
      .deploy(1, 100, treasury.address)
      .then((contract) => contract as unknown as TonicFeePolicyManager)
  })

  describe('Deployment', () => {
    it('should set initial state correctly', async () => {
      expect(await tonicFeePolicyManager.feeNumerator()).to.be.equal(1)
      expect(await tonicFeePolicyManager.feeDenominator()).to.be.equal(100)
      expect(await tonicFeePolicyManager.treasury()).to.equal(treasury.address)
    })
  })

  describe('setFeePolicy', () => {
    it('should update fee policy and emit an event', async () => {
      const receipt = await tonicFeePolicyManager.connect(owner).setFeePolicy(2, 100)

      expect(await tonicFeePolicyManager.feeNumerator()).to.be.equal(2)
      expect(await tonicFeePolicyManager.feeDenominator()).to.be.equal(100)
      expect(receipt)
        .to.emit(tonicFeePolicyManager, 'FeePolicyUpdated')
        .withArgs(BigNumber.from(2), BigNumber.from(100))
    })

    it('should revert if numerator is greater than denominator', async () => {
      await expect(tonicFeePolicyManager.connect(owner).setFeePolicy(101, 100)).to.be.revertedWith(
        'numerator should be less than or equal to denominator',
      )
    })
  })

  describe('setTreasuryAddress', () => {
    it('should update treasury address and emit an event', async () => {
      const receipt = await tonicFeePolicyManager.connect(owner).setTreasuryAddress(newTreasury.address)

      expect(await tonicFeePolicyManager.treasury()).to.equal(newTreasury.address)
      expect(receipt).to.emit(tonicFeePolicyManager, 'TreasuryAddressUpdated').withArgs(newTreasury.address)
    })

    it('should revert if treasury address is zero address', async () => {
      await expect(
        tonicFeePolicyManager.connect(owner).setTreasuryAddress('0x0000000000000000000000000000000000000000'),
      ).to.be.revertedWith('treasury address should not be zero address')
    })
  })

  describe('transfer', () => {
    beforeEach(async () => {
      await owner.sendTransaction({ to: tonicFeePolicyManager.address, value: ethers.utils.parseEther('1') })
    })

    it('should transfer ether to recipient', async () => {
      const initialBalance = await ethers.provider.getBalance(recipient.address)
      const amountToTransfer = ethers.utils.parseEther('0.5')

      await tonicFeePolicyManager['transfer(address,uint256)'](recipient.address, amountToTransfer)

      const finalBalance = await ethers.provider.getBalance(recipient.address)
      expect(finalBalance).to.be.equal(initialBalance.add(amountToTransfer))
    })

    it('should revert if not called by owner', async () => {
      await expect(
        tonicFeePolicyManager
          .connect(recipient)
          ['transfer(address,uint256)'](recipient.address, ethers.utils.parseEther('0.5')),
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })

    describe('transfer tokens', () => {
      let token: ERC20Token

      beforeEach(async () => {
        const tokenFactory = await ethers.getContractFactory('ERC20Token')
        token = await tokenFactory
          .connect(owner)
          .deploy('Example Token', 'EXT', 18, ethers.utils.parseEther('1000'), owner.address)
          .then((contract) => contract as unknown as ERC20Token)

        await token.transfer(tonicFeePolicyManager.address, ethers.utils.parseEther('1000'))
      })

      it('should transfer tokens to recipient', async () => {
        const initialBalance = await token.balanceOf(recipient.address)
        const amountToTransfer = ethers.utils.parseEther('500')

        await tonicFeePolicyManager['transfer(address,address,uint256)'](
          recipient.address,
          token.address,
          amountToTransfer,
        )

        const finalBalance = await token.balanceOf(recipient.address)
        expect(finalBalance).to.be.equal(initialBalance.add(amountToTransfer))
      })

      it('should revert if not called by owner', async () => {
        await expect(
          tonicFeePolicyManager
            .connect(recipient)
            ['transfer(address,address,uint256)'](
              recipient.address,
              token.address,
              ethers.utils.parseEther('500'),
            ),
        ).to.be.revertedWith('Ownable: caller is not the owner')
      })
    })
  })
})
