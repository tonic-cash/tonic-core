import { BigNumber } from '@ethersproject/bignumber'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import circomlib from 'circomlib'
import crypto from 'crypto'
import MerkleTree from 'fixed-merkle-tree'
import fs from 'fs'
import { ethers } from 'hardhat'
import path from 'path'
import snarkjs from 'snarkjs'
import Hasher from '../build/Hasher.json'
import { BadRecipient, ERC20Token, ERC20Tonic } from '../typechain-types'
import { revertToSnapshot, takeSnapshot } from './utils/snapshot'

chai.use(chaiAsPromised)
chai.should()

const FEE_NUMERATOR = 3
const FEE_DENOMINATOR = 100
const TREASURY_ADDRESS = '0x0000000000000000000000000000000000000001'

const ETH_AMOUNT = '1000000000000000000'
const ERC20_AMOUNT = '1000000000000000000'
const TOKEN_AMOUNT = '1000000000000000000'
const MERKLE_TREE_HEIGHT = 20

const websnarkUtils = require('websnark/src/utils')
const buildGroth16 = require('websnark/src/groth16')
const stringifyBigInts = require('websnark/tools/stringifybigint').stringifyBigInts
const snarkjs = require('snarkjs')
const circomlib = require('circomlib')
const MerkleTree = require('fixed-merkle-tree')

const bigInt = snarkjs.bigInt as any

const rbigint = (nbytes: number) => bigInt.leBuff2int(crypto.randomBytes(nbytes))
const pedersenHash = (data: any) =>
  (circomlib.babyJub as any).unpackPoint(circomlib.pedersenHash.hash(data))[0]
const toFixedHex = (number: any, length = 32) =>
  '0x' +
  bigInt(number)
    .toString(16)
    .padStart(length * 2, '0')
const getRandomRecipient = () => rbigint(20)

function generateDeposit() {
  let deposit = {
    secret: rbigint(31),
    nullifier: rbigint(31),
    commitment: '',
  }
  const preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31)])
  deposit.commitment = pedersenHash(preimage)
  return deposit
}

type WithdrawArgs = [string, string, string, string, string, string]

describe('ERC20Tonic', () => {
  let tonic: ERC20Tonic
  let token: ERC20Token
  // let usdtToken: USDTToken
  let badRecipient: BadRecipient

  let sender: SignerWithAddress
  let operator: SignerWithAddress
  let relayer: SignerWithAddress
  let user: SignerWithAddress

  const levels = MERKLE_TREE_HEIGHT || 16
  let tokenDenomination = TOKEN_AMOUNT || '1000000000000000000' // 1 ether
  let snapshotId
  let tree
  const fee = bigInt(ETH_AMOUNT).shr(1) || bigInt(1e17)
  const refund = ETH_AMOUNT || '1000000000000000000' // 1 ether
  let recipient = getRandomRecipient()
  let groth16
  let circuit
  let proving_key

  before(async () => {
    const accounts = await ethers.getSigners()
    ;[sender, relayer, user] = accounts
    operator = sender

    tree = new MerkleTree(levels)
    const tokenFactory = await ethers.getContractFactory('ERC20Token')
    token = (await tokenFactory.deploy('Test', 'TEST', 18, BigNumber.from(0), sender.address) as ERC20Token)
    await token.mint(sender.address, tokenDenomination)

    const tonicFactory = await ethers.getContractFactory('ERC20Tonic')
    const verifierInstance = await (await ethers.getContractFactory('Verifier')).deploy()
    const hasherInstance = await (await ethers.getContractFactory(Hasher.abi, Hasher.bytecode)).deploy()
    const feePolicyManager = await (
      await ethers.getContractFactory('TonicFeePolicyManager')
    ).deploy(FEE_NUMERATOR, FEE_DENOMINATOR, TREASURY_ADDRESS)
    tonic = await tonicFactory.deploy(
      verifierInstance.address,
      hasherInstance.address,
      ERC20_AMOUNT,
      MERKLE_TREE_HEIGHT,
      token.address,
      feePolicyManager.address,
    ) as ERC20Tonic
    badRecipient =( await (

      await ethers.getContractFactory('BadRecipient')
    ).deploy()) as BadRecipient

    snapshotId = await takeSnapshot()
    groth16 = await buildGroth16()
    circuit = require('../constants/withdraw.json')
    proving_key = fs.readFileSync(path.join(__dirname, '../constants/withdraw_proving_key.bin')).buffer
  })

  describe('#constructor', () => {
    it('should initialize', async () => {
      const tokenFromContract = await tonic.token()
      expect(tokenFromContract).to.equal(token.address)
    })
  })

  describe('#deposit', () => {
    it('should work', async () => {
      const commitment = toFixedHex(43)
      await token.connect(sender).approve(tonic.address, tokenDenomination)

      const receipt = await tonic.connect(sender).deposit(commitment, { from: sender.address })
      const events = (await receipt.wait()).events || []
      const depositEvent = events.find((e) => e.event === 'Deposit')

      expect(!!depositEvent).to.equal(true)
      expect(depositEvent?.args?.commitment).to.equal(commitment)
      expect(depositEvent?.args?.leafIndex).to.equal(BigNumber.from(0))
    })

    it('should not allow to send ether on deposit', async () => {
      const commitment = toFixedHex(43)
      await token.connect(sender).approve(tonic.address, tokenDenomination)

      try {
        await tonic.connect(sender).deposit(commitment, { from: sender.address, value: 1e6 })
        throw new Error('Should have failed')
      } catch (error) {
        expect(error.message).to.include('ETH value is supposed to be 0 for ERC20 instance')
      }
    })
  })

  describe('#withdraw', () => {
    it('should work', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      await token.mint(user.address, tokenDenomination)

      const balanceUserBefore = await token.balanceOf(user.address)
      await token.connect(user).approve(tonic.address, tokenDenomination, { from: user.address })
      await tonic.connect(user).deposit(toFixedHex(deposit.commitment), { from: user.address,  })
      const balanceUserAfter = await token.balanceOf(user.address)
      expect(balanceUserAfter).to.equal(balanceUserBefore.sub(BigNumber.from(tokenDenomination)))

      const { pathElements, pathIndices } = tree.path(0)
      // Circuit input
      const input = stringifyBigInts({
        // public
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        relayer: relayer.address,
        recipient,
        fee,
        refund,

        // private
        nullifier: deposit.nullifier,
        secret: deposit.secret,
        pathElements: pathElements,
        pathIndices: pathIndices,
      })

      const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
      const { proof } = websnarkUtils.toSolidityInput(proofData)

      const balanceTonicBefore = await token.balanceOf(tonic.address)
      const balanceRelayerBefore = await token.balanceOf(relayer.address)
      const balanceReceiverBefore = await token.balanceOf(toFixedHex(recipient, 20))

      // const ethBalanceOperatorBefore = await ethers.provider.getBalance(operator.address)
      // const ethBalanceReceiverBefore = await ethers.provider.getBalance(toFixedHex(recipient, 20))
      // const ethBalanceRelayerBefore = await ethers.provider.getBalance(relayer.address)
      let isSpent = await tonic.isSpent(toFixedHex(input.nullifierHash))
      expect(isSpent).to.equal(false)

      const args: WithdrawArgs = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      const receipt = await tonic.connect(relayer).withdraw(proof, ...args, { value: refund, from: relayer.address,  })
      const events = (await receipt.wait()).events || []

      const balanceTonicAfter = await token.balanceOf(tonic.address)
      const balanceRelayerAfter = await token.balanceOf(relayer.address)
      // const ethBalanceOperatorAfter = await ethers.provider.getBalance(operator.address)
      const balanceReceiverAfter = await token.balanceOf(toFixedHex(recipient, 20))
      // const ethBalanceReceiverAfter = await ethers.provider.getBalance(toFixedHex(recipient, 20))
      // const ethBalanceRelayerAfter = await ethers.provider.getBalance(relayer.address)
      const feeBN = BigNumber.from(fee.toString())
      expect(balanceTonicAfter).to.equal(BigNumber.from(balanceTonicBefore).sub(BigNumber.from(tokenDenomination)))
      expect(balanceRelayerAfter).to.equal(BigNumber.from(balanceRelayerBefore).add(feeBN))

      const expectedBalance = BigNumber.from(balanceReceiverBefore).add(BigNumber.from(tokenDenomination))
      const percentage = 100 - (FEE_NUMERATOR / FEE_DENOMINATOR) * 100
      const expectedBalanceAfterProtocolFee = expectedBalance.mul(percentage).div(100).sub(feeBN)
      expect(balanceReceiverAfter).to.equal(BigNumber.from(expectedBalanceAfterProtocolFee))

      // FIXME: Tests for ethereum balances (unimportant; having issue with dynamic fees here)
      // expect(ethBalanceOperatorAfter).to.equal(BigNumber.from(ethBalanceOperatorBefore))
      // expect(ethBalanceReceiverAfter).to.equal(BigNumber.from(ethBalanceReceiverBefore).add(BigNumber.from(refund)))
      // expect(ethBalanceRelayerAfter).to.equal(BigNumber.from(ethBalanceRelayerBefore).sub(BigNumber.from(refund)))

      const withdrawalEvent = events.find((e) => e.event === 'Withdrawal')
      expect(!!withdrawalEvent).to.equal(true)
      expect(withdrawalEvent?.args?.nullifierHash).to.equal(toFixedHex(input.nullifierHash))
      expect(withdrawalEvent?.args?.relayer).to.equal(relayer.address)
      expect(withdrawalEvent?.args?.fee).to.equal(feeBN)
      isSpent = await tonic.isSpent(toFixedHex(input.nullifierHash))
      expect(isSpent).to.equal(true)
    })

    it('should reject with wrong refund value', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      await token.mint(user.address, tokenDenomination)
      await token.connect(user).approve(tonic.address, tokenDenomination, { from: user.address })
      await tonic.connect(user).deposit(toFixedHex(deposit.commitment), { from: user.address,  })

      const { pathElements, pathIndices } = tree.path(0)
      // Circuit input
      const input = stringifyBigInts({
        // public
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        relayer: relayer.address,
        recipient,
        fee,
        refund,

        // private
        nullifier: deposit.nullifier,
        secret: deposit.secret,
        pathElements: pathElements,
        pathIndices: pathIndices,
      })

      const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
      const { proof } = websnarkUtils.toSolidityInput(proofData)

      const args: WithdrawArgs = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      let error = await tonic.connect(relayer).withdraw(proof, ...args, { value: 1, from: relayer.address,  }).should.rejected
      expect(error.message).to.include('Incorrect refund amount received by the contract')
      error = await tonic.connect(relayer).withdraw(proof, ...args, {
        value: BigNumber.from(refund).mul(BigNumber.from(2)),
        from: relayer.address,
      }).should.rejected
      expect(error.message).to.include('Incorrect refund amount received by the contract')
    })
  })

  afterEach(async () => {
    await revertToSnapshot(snapshotId)
    // eslint-disable-next-line require-atomic-updates
    snapshotId = await takeSnapshot()
    tree = new MerkleTree(levels)
  })
})
