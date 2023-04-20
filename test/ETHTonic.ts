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
import { ETHTonic } from '../typechain-types'
import { revertToSnapshot, takeSnapshot } from './utils/snapshot'

const ETH_AMOUNT = '1000000000000000000'
const MERKLE_TREE_HEIGHT = 20
const FEE_NUMERATOR = 3
const FEE_DENOMINATOR = 100
const TREASURY_ADDRESS = '0x0000000000000000000000000000000000000000'

// chai.use(solidity(BN))
chai.use(chaiAsPromised)
chai.should()

const websnarkUtils = require('websnark/src/utils')
const buildGroth16 = require('websnark/src/groth16')
const stringifyBigInts = require('websnark/tools/stringifybigint').stringifyBigInts
const unstringifyBigInts2 = require('snarkjs/src/stringifybigint').unstringifyBigInts

const bigInt = snarkjs.bigInt

const rbigint = (nbytes: number) => snarkjs.bigInt.leBuff2int(crypto.randomBytes(nbytes))
const pedersenHash = (data: any) => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]
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

      const args: [string, string, string, string, string, string] = [
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

  afterEach(async () => {
    await revertToSnapshot(snapshotId)
    snapshotId = await takeSnapshot()
    tree = new MerkleTree(levels)
  })
})
