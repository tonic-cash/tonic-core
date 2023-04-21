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
import { randomHex } from 'web3-utils'

import Hasher from '../build/Hasher.json'
import { ERC20Token, ETHTonic, KIP7Token } from '../typechain-types'
import { revertToSnapshot, takeSnapshot } from './utils/snapshot'

const ETH_AMOUNT = '1000000000000000000'
const MERKLE_TREE_HEIGHT = 20
const FEE_NUMERATOR = 3
const FEE_DENOMINATOR = 100
const TREASURY_ADDRESS = '0x0000000000000000000000000000000000000000'

chai.use(chaiAsPromised)
chai.should()

const websnarkUtils = require('websnark/src/utils')
const buildGroth16 = require('websnark/src/groth16')
const stringifyBigInts = require('websnark/tools/stringifybigint').stringifyBigInts
const unstringifyBigInts2 = require('snarkjs/src/stringifybigint').unstringifyBigInts

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

function snarkVerify(proof: any) {
  proof = unstringifyBigInts2(proof)
  const verification_key = unstringifyBigInts2(require('../constants/withdraw_verification_key.json'))
  return snarkjs['groth'].isValid(verification_key, proof, proof.publicSignals)
}

type WithdrawArgs = [string, string, string, string, string, string]

describe('ETHTonic', () => {
  let tonic: ETHTonic
  let sender: SignerWithAddress
  let operator: SignerWithAddress
  let relayer: SignerWithAddress
  let accounts: SignerWithAddress[]

  const levels = MERKLE_TREE_HEIGHT || 16
  const value = ETH_AMOUNT || '1000000000000000000' // 1 ether
  let snapshotId: string
  let tree: any
  const fee = bigInt(value).shr(1) || bigInt(1e17)
  const refund = bigInt(0)
  const recipient = getRandomRecipient()

  let groth16: any
  let circuit: any
  let proving_key: any

  before(async () => {
    tree = new MerkleTree(levels)
    const tonicFactory = await ethers.getContractFactory('ETHTonic')
    const verifierInstance = await (await ethers.getContractFactory('Verifier')).deploy()
    const hasherInstance = await (await ethers.getContractFactory(Hasher.abi, Hasher.bytecode)).deploy()
    const feePolicyManager = await (
      await ethers.getContractFactory('TonicFeePolicyManager')
    ).deploy(FEE_NUMERATOR, FEE_DENOMINATOR, TREASURY_ADDRESS)

    tonic = (await tonicFactory.deploy(
      verifierInstance.address,
      hasherInstance.address,
      ETH_AMOUNT,
      MERKLE_TREE_HEIGHT,
      feePolicyManager.address,
    )) as ETHTonic

    snapshotId = await takeSnapshot()
    groth16 = await buildGroth16()
    circuit = require('../constants/withdraw.json')
    proving_key = proving_key = fs.readFileSync(
      path.join(__dirname, '../constants/withdraw_proving_key.bin'),
    ).buffer

    accounts = await ethers.getSigners()
    ;[sender, relayer] = accounts
    operator = sender
  })

  describe('#constructor', () => {
    it('should initialize', async () => {
      const etherDenomination = await tonic.denomination()
      expect(etherDenomination).to.equal(BigNumber.from(ETH_AMOUNT))
    })
  })

  describe('#deposit', () => {
    it('should emit event', async () => {
      let commitment = toFixedHex(42)
      let receipt = await tonic.connect(sender).deposit(commitment, { value, from: sender.address })
      let events = (await receipt.wait()).events || []

      expect(events[0].event).to.equal('Deposit')
      expect(events[0].args?.commitment).to.equal(commitment)
      expect(events[0].args?.leafIndex).to.equal(BigNumber.from(0))

      commitment = toFixedHex(12)
      receipt = await tonic.connect(accounts[2]).deposit(commitment, { value, from: accounts[2].address })
      events = (await receipt.wait()).events || []

      expect(events[0].event).to.equal('Deposit')
      expect(events[0].args?.commitment).to.equal(commitment)
      expect(events[0].args?.leafIndex).to.equal(BigNumber.from(1))
    })

    it('should throw if there is a such commitment', async () => {
      const commitment = toFixedHex(48)
      await tonic.connect(sender).deposit(commitment, { value, from: sender.address }).should.fulfilled
      const error = await tonic.connect(sender).deposit(commitment, { value, from: sender.address }).should
        .rejected
      expect(error.message).to.include('The commitment has been submitted')
    })
  })

  describe('snark proof verification on js side', () => {
    it('should detect tampering', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      const { pathElements, pathIndices } = tree.path(0)

      const input = stringifyBigInts({
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        nullifier: deposit.nullifier,
        relayer: operator.address,
        recipient,
        fee,
        refund,
        secret: deposit.secret,
        pathElements: pathElements,
        pathIndices: pathIndices,
      })

      let proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
      const originalProof = JSON.parse(JSON.stringify(proofData))
      let result = snarkVerify(proofData)
      result.should.equal(true)

      // nullifier
      proofData.publicSignals[1] =
        '133792158246920651341275668520530514036799294649489851421007411546007850802'
      result = snarkVerify(proofData)
      result.should.equal(false)
      proofData = originalProof

      // try to cheat with recipient
      proofData.publicSignals[2] = '133738360804642228759657445999390850076318544422'
      result = snarkVerify(proofData)
      result.should.equal(false)
      proofData = originalProof

      // fee
      proofData.publicSignals[3] = '1337100000000000000000'
      result = snarkVerify(proofData)
      result.should.equal(false)
      proofData = originalProof
    })
  })

  describe('#withdraw', () => {
    it('should work', async () => {
      const deposit = generateDeposit()
      const user = accounts[4]
      tree.insert(deposit.commitment)

      const balanceUserBefore = await ethers.provider.getBalance(user.address)
      await tonic.connect(user).deposit(toFixedHex(deposit.commitment), {
        value,
        from: user.address,
      })
      const balanceUserAfter = await ethers.provider.getBalance(user.address)
      let isBalanceValid = balanceUserAfter.lte(BigNumber.from(balanceUserBefore).sub(BigNumber.from(value)))
      expect(isBalanceValid).to.equal(true)

      const { pathElements, pathIndices } = tree.path(0)

      // Circuit input
      const input = stringifyBigInts({
        // public
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        relayer: operator.address,
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

      const balanceTonicBefore = await ethers.provider.getBalance(tonic.address)
      const balanceRelayerBefore = await ethers.provider.getBalance(relayer.address)
      const balanceOperatorBefore = await ethers.provider.getBalance(operator.address)
      const balanceReceiverBefore = await ethers.provider.getBalance(toFixedHex(recipient, 20))
      let isSpent = await tonic.isSpent(toFixedHex(input.nullifierHash))
      isSpent.should.be.equal(false)

      // Uncomment to measure gas usage
      // gas = await tonic.withdraw.estimateGas(proof, publicSignals, { from: relayer, gasPrice: '0' })
      // console.log('withdraw gas:', gas)
      const args: WithdrawArgs = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      let receipt = await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address })
      const events = (await receipt.wait()).events

      const balanceTonicAfter = await ethers.provider.getBalance(tonic.address)
      const balanceRelayerAfter = await ethers.provider.getBalance(relayer.address)
      const balanceOperatorAfter = await ethers.provider.getBalance(operator.address)
      const balanceReceiverAfter = await ethers.provider.getBalance(toFixedHex(recipient, 20))
      const feeBN = BigNumber.from(fee.toString())

      isBalanceValid = balanceTonicAfter.lte(BigNumber.from(balanceTonicBefore).sub(BigNumber.from(value)))
      expect(isBalanceValid).to.equal(true)
      isBalanceValid = balanceOperatorAfter.gte(BigNumber.from(balanceOperatorBefore).add(feeBN))
      expect(isBalanceValid).to.equal(true)

      // value - protocol fee
      const expectedBalance = BigNumber.from(balanceReceiverBefore).add(BigNumber.from(value))
      const percentage = 100 - (FEE_NUMERATOR / FEE_DENOMINATOR) * 100
      const expectedBalanceAfterProtocolFee = expectedBalance.mul(percentage).div(100).sub(feeBN)
      const difference = expectedBalance.sub(expectedBalanceAfterProtocolFee)

      const lowerBound = expectedBalanceAfterProtocolFee.sub(difference)
      const upperBound = expectedBalanceAfterProtocolFee.add(difference)
      const isWithinRange =
        BigNumber.from(balanceReceiverAfter).gte(lowerBound) &&
        BigNumber.from(balanceReceiverAfter).lte(upperBound)
      expect(isWithinRange).to.equal(true)

      expect(events?.[0].event).to.equal('Withdrawal')
      expect(events?.[0].args?.nullifierHash).to.equal(toFixedHex(input.nullifierHash))
      expect(events?.[0].args?.fee).to.equal(feeBN)
      expect(events?.[0].args?.relayer).to.equal(operator.address)
      isSpent = await tonic.isSpent(toFixedHex(input.nullifierHash))
      expect(isSpent).to.equal(true)
    })

    it('should prevent double spend', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      await tonic.connect(sender).deposit(toFixedHex(deposit.commitment), { value, from: sender.address })

      const { pathElements, pathIndices } = tree.path(0)

      const input = stringifyBigInts({
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        nullifier: deposit.nullifier,
        relayer: operator.address,
        recipient,
        fee,
        refund,
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
      await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address }).should.be.fulfilled
      const error = await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address }).should
        .rejected
      expect(error.message).to.include('The note has been already spent')
    })

    it('should prevent double spend with overflow', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      await tonic.connect(sender).deposit(toFixedHex(deposit.commitment), { value, from: sender.address })

      const { pathElements, pathIndices } = tree.path(0)

      const input = stringifyBigInts({
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        nullifier: deposit.nullifier,
        relayer: operator.address,
        recipient,
        fee,
        refund,
        secret: deposit.secret,
        pathElements: pathElements,
        pathIndices: pathIndices,
      })
      const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
      const { proof } = websnarkUtils.toSolidityInput(proofData)
      const args: WithdrawArgs = [
        toFixedHex(input.root),
        toFixedHex(
          BigNumber.from(input.nullifierHash).add(
            BigNumber.from('21888242871839275222246405745257275088548364400416034343698204186575808495617'),
          ),
        ),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      const error = await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address }).should
        .rejected
      expect(error.message).to.include('verifier-gte-snark-scalar-field')
    })

    it('fee should be less or equal transfer value', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      await tonic.connect(sender).deposit(toFixedHex(deposit.commitment), { value, from: sender.address })

      const { pathElements, pathIndices } = tree.path(0)
      const largeFee = bigInt(value).add(bigInt(1))
      const input = stringifyBigInts({
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        nullifier: deposit.nullifier,
        relayer: operator.address,
        recipient,
        fee: largeFee,
        refund,
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
      const error = await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address }).should
        .rejected
      expect(error.message).to.include('Fee exceeds transfer value')
    })

    it('should throw for corrupted merkle tree root', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      await tonic.connect(sender).deposit(toFixedHex(deposit.commitment), { value, from: sender.address })

      const { pathElements, pathIndices } = tree.path(0)

      const input = stringifyBigInts({
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        root: tree.root(),
        nullifier: deposit.nullifier,
        relayer: operator.address,
        recipient,
        fee,
        refund,
        secret: deposit.secret,
        pathElements: pathElements,
        pathIndices: pathIndices,
      })

      const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
      const { proof } = websnarkUtils.toSolidityInput(proofData)

      const args: WithdrawArgs = [
        toFixedHex(randomHex(32)),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      const error = await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address }).should
        .rejected
      expect(error.message).to.include('Cannot find your merkle root')
    })

    it('should reject with tampered public inputs', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      await tonic.connect(sender).deposit(toFixedHex(deposit.commitment), { value, from: sender.address })

      let { pathElements, pathIndices } = tree.path(0)

      const input = stringifyBigInts({
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        nullifier: deposit.nullifier,
        relayer: operator.address,
        recipient,
        fee,
        refund,
        secret: deposit.secret,
        pathElements: pathElements,
        pathIndices: pathIndices,
      })
      const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
      let { proof } = websnarkUtils.toSolidityInput(proofData)
      const args: WithdrawArgs = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      let incorrectArgs: WithdrawArgs
      const originalProof = proof.slice()

      // recipient
      incorrectArgs = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex('0x0000000000000000000000007a1f9131357404ef86d7c38dbffed2da70321337', 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      let error = await tonic.connect(relayer).withdraw(proof, ...incorrectArgs, { from: relayer.address })
        .should.rejected
      expect(error.message).to.include('Invalid withdraw proof')

      // fee
      incorrectArgs = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex('0x000000000000000000000000000000000000000000000000015345785d8a0000'),
        toFixedHex(input.refund),
      ]
      error = await tonic.connect(relayer).withdraw(proof, ...incorrectArgs, { from: relayer.address }).should
        .rejected
      expect(error.message).to.include('Invalid withdraw proof')

      // nullifier
      incorrectArgs = [
        toFixedHex(input.root),
        toFixedHex('0x00abdfc78211f8807b9c6504a6e537e71b8788b2f529a95f1399ce124a8642ad'),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      error = await tonic.connect(relayer).withdraw(proof, ...incorrectArgs, { from: relayer.address }).should
        .rejected
      expect(error.message).to.include('Invalid withdraw proof')

      // proof itself
      proof = '0xbeef' + proof.substr(6)
      await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address }).should.rejected

      // should work with original values
      await tonic.connect(relayer).withdraw(originalProof, ...args, { from: relayer.address }).should.be
        .fulfilled
    })

    it('should reject with non zero refund', async () => {
      const deposit = generateDeposit()
      tree.insert(deposit.commitment)
      await tonic.connect(sender).deposit(toFixedHex(deposit.commitment), { value, from: sender.address })

      const { pathElements, pathIndices } = tree.path(0)

      const input = stringifyBigInts({
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        root: tree.root(),
        nullifier: deposit.nullifier,
        relayer: operator.address,
        recipient,
        fee,
        refund: bigInt(1),
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
      const error = await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address }).should
        .rejected
      expect(error.message).to.include('Refund value is supposed to be zero for ETH instance')
    })
  })

  describe('#isSpent', () => {
    it('should work', async () => {
      const deposit1 = generateDeposit()
      const deposit2 = generateDeposit()
      tree.insert(deposit1.commitment)
      tree.insert(deposit2.commitment)
      await tonic.connect(sender).deposit(toFixedHex(deposit1.commitment), { value, from: sender.address })
      await tonic.connect(sender).deposit(toFixedHex(deposit2.commitment), { value, from: sender.address })

      const { pathElements, pathIndices } = tree.path(1)

      // Circuit input
      const input = stringifyBigInts({
        // public
        root: tree.root(),
        nullifierHash: pedersenHash(deposit2.nullifier.leInt2Buff(31)),
        relayer: operator.address,
        recipient,
        fee,
        refund,

        // private
        nullifier: deposit2.nullifier,
        secret: deposit2.secret,
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

      await tonic.connect(relayer).withdraw(proof, ...args, { from: relayer.address })

      const nullifierHash1 = toFixedHex(pedersenHash(deposit1.nullifier.leInt2Buff(31)))
      const nullifierHash2 = toFixedHex(pedersenHash(deposit2.nullifier.leInt2Buff(31)))
      const spentArray = await tonic.isSpentArray([nullifierHash1, nullifierHash2])
      spentArray.should.deep.equal([false, true])
    })
  })

  describe('Token Transfers & KIP7', function () {
    let owner: SignerWithAddress
    let stranger: SignerWithAddress
    let token: KIP7Token
    let amount: BigNumber

    beforeEach(async function () {
      ;[owner, stranger] = await ethers.getSigners()

      const TokenFactory = await ethers.getContractFactory('KIP7Token')
      token = (await TokenFactory.deploy(
        'Airdrop',
        'ADT',
        BigNumber.from(18),
        BigNumber.from(0),
        owner.address,
      )) as KIP7Token
      amount = BigNumber.from(500).mul(BigNumber.from(10).pow(18))
      await token.mint(owner.address, amount)
    })

    it('can receive KIP7 tokens', async function () {
      await token.transfer(tonic.address, amount)

      const recipientBalance = await token.balanceOf(tonic.address)
      expect(recipientBalance).to.equal(amount)
    })

    it('can transfer KIP7 tokens to owner', async function () {
      await token.transfer(tonic.address, amount)

      let ownerBalance = await token.balanceOf(owner.address)
      expect(ownerBalance).to.equal(BigNumber.from(0))

      await tonic.transfer(owner.address, token.address, amount)
      ownerBalance = await token.balanceOf(owner.address)
      expect(ownerBalance).to.equal(amount)
    })

    it('reverts if not called by owner', async function () {
      await token.transfer(tonic.address, amount)

      const ownerBalance = await token.balanceOf(owner.address)
      expect(ownerBalance).to.equal(BigNumber.from(0))

      const error = await tonic
        .connect(stranger)
        ['transfer(address,address,uint256)'](stranger.address, token.address, amount).should.rejected
      expect(error.message).to.include('Ownable: caller is not the owner')
    })
  })

  afterEach(async () => {
    await revertToSnapshot(snapshotId)
    snapshotId = await takeSnapshot()
    tree = new MerkleTree(levels)
  })
})
