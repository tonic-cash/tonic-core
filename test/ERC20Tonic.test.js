/* global artifacts, web3, contract */
const BN = require('bn.js')

const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
chai.use(require('bn-chai')(BN));
chai.use(chaiAsPromised);
chai.should();

const fs = require('fs')

const { toBN } = require('web3-utils')
const { takeSnapshot, revertSnapshot } = require('../scripts/ganacheHelper')

const Tonic = artifacts.require('ERC20Tonic')
const BadRecipient = artifacts.require('BadRecipient')
const Token = artifacts.require('ERC20Token')
const USDTToken = artifacts.require('IUSDT')

const ETH_AMOUNT = '1000000000000000000'
const TOKEN_AMOUNT = '1000000000000000000'
const ERC20_TOKEN = undefined
const MERKLE_TREE_HEIGHT = 20

const websnarkUtils = require('websnark/src/utils')
const buildGroth16 = require('websnark/src/groth16')
const stringifyBigInts = require('websnark/tools/stringifybigint').stringifyBigInts
const snarkjs = require('snarkjs')
const bigInt = snarkjs.bigInt
const crypto = require('crypto')
const circomlib = require('circomlib')
const MerkleTree = require('fixed-merkle-tree');
const path = require('path');

const rbigint = (nbytes) => snarkjs.bigInt.leBuff2int(crypto.randomBytes(nbytes))
const pedersenHash = (data) => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]
const toFixedHex = (number, length = 32) =>
  '0x' +
  bigInt(number)
    .toString(16)
    .padStart(length * 2, '0')
const getRandomRecipient = () => rbigint(20)

function generateDeposit() {
  let deposit = {
    secret: rbigint(31),
    nullifier: rbigint(31),
  }
  const preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31)])
  deposit.commitment = pedersenHash(preimage)
  return deposit
}

contract.only('ERC20Tonic', (accounts) => {
  let tonic
  let token
  let usdtToken
  let badRecipient
  const sender = accounts[0]
  const operator = accounts[0]
  const levels = MERKLE_TREE_HEIGHT || 16
  let tokenDenomination = TOKEN_AMOUNT || '1000000000000000000' // 1 ether
  let snapshotId
  let tree
  const fee = bigInt(ETH_AMOUNT).shr(1) || bigInt(1e17)
  const refund = ETH_AMOUNT || '1000000000000000000' // 1 ether
  let recipient = getRandomRecipient()
  const relayer = accounts[1]
  let groth16
  let circuit
  let proving_key

  before(async () => {
    tree = new MerkleTree(levels)
    tonic = await Tonic.deployed()
    if (ERC20_TOKEN) {
      token = await Token.at(ERC20_TOKEN)
      usdtToken = await USDTToken.at(ERC20_TOKEN)
    } else {
      const tokenAddress = await tonic.token()
      token = await Token.at(tokenAddress)
      await token.mint(sender, tokenDenomination)
    }
    badRecipient = await BadRecipient.new()
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
      await token.approve(tonic.address, tokenDenomination)

      let { logs } = await tonic.deposit(commitment, { from: sender })

      expect(logs[0].event).to.equal('Deposit')
      expect(logs[0].args.commitment).to.equal(commitment)
      expect(logs[0].args.leafIndex).should.be.eq.BN(0)
    })

    it('should not allow to send ether on deposit', async () => {
      const commitment = toFixedHex(43)
      await token.approve(tonic.address, tokenDenomination)

      try {
        await tonic.deposit(commitment, { from: sender, value: 1e6 })
        throw new Error('Should have failed')
      } catch (error) {
        expect(error.reason).to.equal('ETH value is supposed to be 0 for ERC20 instance')
      }
    })
  })

  describe('#withdraw', () => {
    it('should work', async () => {
      const deposit = generateDeposit()
      const user = accounts[4]
      tree.insert(deposit.commitment)
      await token.mint(user, tokenDenomination)

      const balanceUserBefore = await token.balanceOf(user)
      await token.approve(tonic.address, tokenDenomination, { from: user })
      await tonic.deposit(toFixedHex(deposit.commitment), { from: user, gasPrice: '0' })
      const balanceUserAfter = await token.balanceOf(user)
      expect(balanceUserAfter).should.be.eq.BN((balanceUserBefore).sub(toBN(tokenDenomination)))

      const { pathElements, pathIndices } = tree.path(0)
      // Circuit input
      const input = stringifyBigInts({
        // public
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        relayer,
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
      const balanceRelayerBefore = await token.balanceOf(relayer)
      const balanceReceiverBefore = await token.balanceOf(toFixedHex(recipient, 20))

      const ethBalanceOperatorBefore = await web3.eth.getBalance(operator)
      const ethBalanceReceiverBefore = await web3.eth.getBalance(toFixedHex(recipient, 20))
      const ethBalanceRelayerBefore = await web3.eth.getBalance(relayer)
      let isSpent = await tonic.isSpent(toFixedHex(input.nullifierHash))
      expect(isSpent).to.equal(false)
      // Uncomment to measure gas usage
      // gas = await tonic.withdraw.estimateGas(proof, publicSignals, { from: relayer, gasPrice: '0' })
      // console.log('withdraw gas:', gas)
      const args = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      const { logs } = await tonic.withdraw(proof, ...args, { value: refund, from: relayer, gasPrice: '0' })

      const balanceTonicAfter = await token.balanceOf(tonic.address)
      const balanceRelayerAfter = await token.balanceOf(relayer)
      const ethBalanceOperatorAfter = await web3.eth.getBalance(operator)
      const balanceReceiverAfter = await token.balanceOf(toFixedHex(recipient, 20))
      const ethBalanceReceiverAfter = await web3.eth.getBalance(toFixedHex(recipient, 20))
      const ethBalanceRelayerAfter = await web3.eth.getBalance(relayer)
      const feeBN = toBN(fee.toString())
      expect(balanceTonicAfter).should.be.eq.BN(toBN(balanceTonicBefore).sub(toBN(tokenDenomination)))
      expect(balanceRelayerAfter).should.be.eq.BN(toBN(balanceRelayerBefore).add(feeBN))
      expect(balanceReceiverAfter).should.be.eq.BN(
        toBN(balanceReceiverBefore).add(toBN(tokenDenomination).sub(feeBN)),
      )

      expect(ethBalanceOperatorAfter).should.be.eq.BN(toBN(ethBalanceOperatorBefore))
      expect(ethBalanceReceiverAfter).should.be.eq.BN(toBN(ethBalanceReceiverBefore).add(toBN(refund)))
      expect(ethBalanceRelayerAfter).should.be.eq.BN(toBN(ethBalanceRelayerBefore).sub(toBN(refund)))

      expect(logs[0].event).to.equal('Withdrawal')
      expect(logs[0].args.nullifierHash).to.equal(toFixedHex(input.nullifierHash))
      expect(logs[0].args.relayer).to.equal(relayer)
      expect(logs[0].args.fee).should.be.eq.BN(feeBN)
      isSpent = await tonic.isSpent(toFixedHex(input.nullifierHash))
      expect(isSpent).to.equal(true)
    })

    // it('should return refund to the relayer is case of fail', async () => {
    //   const deposit = generateDeposit()
    //   const user = accounts[4]
    //   recipient = bigInt(badRecipient.address)
    //   tree.insert(deposit.commitment)
    //   await token.mint(user, tokenDenomination)

    //   const balanceUserBefore = await token.balanceOf(user)
    //   await token.approve(tonic.address, tokenDenomination, { from: user })
    //   await tonic.deposit(toFixedHex(deposit.commitment), { from: user, gasPrice: '0' })

    //   const balanceUserAfter = await token.balanceOf(user)
    //   expect(balanceUserAfter).should.be.eq.BN((balanceUserBefore).sub(toBN(tokenDenomination)))

    //   const { pathElements, pathIndices } = tree.path(0)
    //   // Circuit input
    //   const input = stringifyBigInts({
    //     // public
    //     root: tree.root(),
    //     nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
    //     relayer,
    //     recipient,
    //     fee,
    //     refund,

    //     // private
    //     nullifier: deposit.nullifier,
    //     secret: deposit.secret,
    //     pathElements: pathElements,
    //     pathIndices: pathIndices,
    //   })

    //   const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
    //   const { proof } = websnarkUtils.toSolidityInput(proofData)

    //   const balanceTonicBefore = await token.balanceOf(tonic.address)
    //   const balanceRelayerBefore = await token.balanceOf(relayer)
    //   const balanceReceiverBefore = await token.balanceOf(toFixedHex(recipient, 20))

    //   const ethBalanceOperatorBefore = await web3.eth.getBalance(operator)
    //   const ethBalanceReceiverBefore = await web3.eth.getBalance(toFixedHex(recipient, 20))
    //   const ethBalanceRelayerBefore = await web3.eth.getBalance(relayer)
    //   let isSpent = await tonic.isSpent(toFixedHex(input.nullifierHash))
    //   expect(isSpent).to.equal(false)

    //   const args = [
    //     toFixedHex(input.root),
    //     toFixedHex(input.nullifierHash),
    //     toFixedHex(input.recipient, 20),
    //     toFixedHex(input.relayer, 20),
    //     toFixedHex(input.fee),
    //     toFixedHex(input.refund),
    //   ]
    //   const { logs } = await tonic.withdraw(proof, ...args, { value: refund, from: relayer, gasPrice: '0' })

    //   const balanceTonicAfter = await token.balanceOf(tonic.address)
    //   const balanceRelayerAfter = await token.balanceOf(relayer)
    //   const ethBalanceOperatorAfter = await web3.eth.getBalance(operator)
    //   const balanceReceiverAfter = await token.balanceOf(toFixedHex(recipient, 20))
    //   const ethBalanceReceiverAfter = await web3.eth.getBalance(toFixedHex(recipient, 20))
    //   const ethBalanceRelayerAfter = await web3.eth.getBalance(relayer)
    //   const feeBN = toBN(fee.toString())
    //   expect(balanceTonicAfter).should.be.eq.BN(toBN(balanceTonicBefore).sub(toBN(tokenDenomination)))
    //   expect(balanceRelayerAfter).should.be.eq.BN(toBN(balanceRelayerBefore).add(feeBN))
    //   expect(balanceReceiverAfter).should.be.eq.BN(
    //     toBN(balanceReceiverBefore).add(toBN(tokenDenomination).sub(feeBN)),
    //   )

    //   expect(ethBalanceOperatorAfter).should.be.eq.BN(toBN(ethBalanceOperatorBefore))
    //   expect(ethBalanceReceiverAfter).should.be.eq.BN(toBN(ethBalanceReceiverBefore))
    //   expect(ethBalanceRelayerAfter).should.be.eq.BN(toBN(ethBalanceRelayerBefore))

    //   expect(logs[0].event).to.equal('Withdrawal')
    //   expect(logs[0].args.nullifierHash).to.equal(toFixedHex(input.nullifierHash))
    //   expect(logs[0].args.relayer).should.be.eq.BN(relayer)
    //   expect(logs[0].args.fee).should.be.eq.BN(feeBN)
    //   isSpent = await tonic.isSpent(toFixedHex(input.nullifierHash))
    //   expect(isSpent).to.equal(true)
    // })

    it('should reject with wrong refund value', async () => {
      const deposit = generateDeposit()
      const user = accounts[4]
      tree.insert(deposit.commitment)
      await token.mint(user, tokenDenomination)
      await token.approve(tonic.address, tokenDenomination, { from: user })
      await tonic.deposit(toFixedHex(deposit.commitment), { from: user, gasPrice: '0' })

      const { pathElements, pathIndices } = tree.path(0)
      // Circuit input
      const input = stringifyBigInts({
        // public
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        relayer,
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

      const args = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      let { reason } = await tonic.withdraw(proof, ...args, { value: 1, from: relayer, gasPrice: '0' }).should
        .be.rejected
      expect(reason).to.equal('Incorrect refund amount received by the contract')
      ;({ reason } = await tonic.withdraw(proof, ...args, {
        value: toBN(refund).mul(toBN(2)),
        from: relayer,
        gasPrice: '0',
      }).should.be.rejected)
      expect(reason).to.equal('Incorrect refund amount received by the contract')
    })

    it.skip('should work with REAL USDT', async () => {
      // dont forget to specify your token in .env
      // USDT decimals is 6, so TOKEN_AMOUNT=1000000
      // and sent `tokenDenomination` to accounts[0] (0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1)
      // run ganache as
      // ganache-cli --fork https://kovan.infura.io/v3/27a9649f826b4e31a83e07ae09a87448@13147586  -d --keepAliveTimeout 20
      const deposit = generateDeposit()
      const user = accounts[4]
      const userBal = await usdtToken.balanceOf(user)
      console.log('userBal', userBal.toString())
      const senderBal = await usdtToken.balanceOf(sender)
      console.log('senderBal', senderBal.toString())
      tree.insert(deposit.commitment)
      await usdtToken.transfer(user, tokenDenomination, { from: sender })
      console.log('transfer done')

      const balanceUserBefore = await usdtToken.balanceOf(user)
      console.log('balanceUserBefore', balanceUserBefore.toString())
      await usdtToken.approve(tonic.address, tokenDenomination, { from: user })
      console.log('approve done')
      const allowanceUser = await usdtToken.allowance(user, tonic.address)
      console.log('allowanceUser', allowanceUser.toString())
      await tonic.deposit(toFixedHex(deposit.commitment), { from: user, gasPrice: '0' })
      console.log('deposit done')

      const balanceUserAfter = await usdtToken.balanceOf(user)
      expect(balanceUserAfter).should.be.eq.BN(toBN(balanceUserBefore).sub(toBN(tokenDenomination)))

      const { pathElements, pathIndices } = tree.path(0)

      // Circuit input
      const input = stringifyBigInts({
        // public
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        relayer: operator,
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

      const balanceTonicBefore = await usdtToken.balanceOf(tonic.address)
      const balanceRelayerBefore = await usdtToken.balanceOf(relayer)
      const ethBalanceOperatorBefore = await web3.eth.getBalance(operator)
      const balanceReceiverBefore = await usdtToken.balanceOf(toFixedHex(recipient, 20))
      const ethBalanceReceiverBefore = await web3.eth.getBalance(toFixedHex(recipient, 20))
      let isSpent = await tonic.isSpent(input.nullifierHash.toString(16).padStart(66, '0x00000'))
      expect(isSpent).to.equal(false)

      // Uncomment to measure gas usage
      // gas = await tonic.withdraw.estimateGas(proof, publicSignals, { from: relayer, gasPrice: '0' })
      // console.log('withdraw gas:', gas)
      const args = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      const { logs } = await tonic.withdraw(proof, ...args, { value: refund, from: relayer, gasPrice: '0' })

      const balanceTonicAfter = await usdtToken.balanceOf(tonic.address)
      const balanceRelayerAfter = await usdtToken.balanceOf(relayer)
      const ethBalanceOperatorAfter = await web3.eth.getBalance(operator)
      const balanceReceiverAfter = await usdtToken.balanceOf(toFixedHex(recipient, 20))
      const ethBalanceReceiverAfter = await web3.eth.getBalance(toFixedHex(recipient, 20))
      const feeBN = toBN(fee.toString())
      expect(balanceTonicAfter).should.be.eq.BN(toBN(balanceTonicBefore).sub(toBN(tokenDenomination)))
      expect(balanceRelayerAfter).should.be.eq.BN(toBN(balanceRelayerBefore))
      expect(ethBalanceOperatorAfter).should.be.eq.BN(toBN(ethBalanceOperatorBefore).add(feeBN))
      expect(balanceReceiverAfter).should.be.eq.BN(toBN(balanceReceiverBefore).add(toBN(tokenDenomination)))
      expect(ethBalanceReceiverAfter).should.be.eq.BN(toBN(ethBalanceReceiverBefore).add(toBN(refund)).sub(feeBN))

      expect(logs[0].event).to.equal('Withdrawal')
      expect(logs[0].args.nullifierHash).should.be.eq.BN(toBN(input.nullifierHash.toString()))
      expect(logs[0].args.relayer).should.be.eq.BN(operator)
      expect(logs[0].args.fee).should.be.eq.BN(feeBN)
      isSpent = await tonic.isSpent(input.nullifierHash.toString(16).padStart(66, '0x00000'))
      expect(isSpent).to.equal(true)
    })

    it.skip('should work with REAL DAI', async () => {
      // dont forget to specify your token in .env
      // and send `tokenDenomination` to accounts[0] (0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1)
      // run ganache as
      // npx ganache-cli --fork https://kovan.infura.io/v3/27a9649f826b4e31a83e07ae09a87448@13146218 -d --keepAliveTimeout 20
      const deposit = generateDeposit()
      const user = accounts[4]
      const userBal = await token.balanceOf(user)
      console.log('userBal', userBal.toString())
      const senderBal = await token.balanceOf(sender)
      console.log('senderBal', senderBal.toString())
      tree.insert(deposit.commitment)
      await token.transfer(user, tokenDenomination, { from: sender })
      console.log('transfer done')

      const balanceUserBefore = await token.balanceOf(user)
      console.log('balanceUserBefore', balanceUserBefore.toString())
      await token.approve(tonic.address, tokenDenomination, { from: user })
      console.log('approve done')
      await tonic.deposit(toFixedHex(deposit.commitment), { from: user, gasPrice: '0' })
      console.log('deposit done')

      const balanceUserAfter = await token.balanceOf(user)
      expect(balanceUserAfter).should.be.eq.BN(toBN(balanceUserBefore).sub(toBN(tokenDenomination)))

      const { pathElements, pathIndices } = tree.path(0)

      // Circuit input
      const input = stringifyBigInts({
        // public
        root: tree.root(),
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        relayer: operator,
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
      const balanceRelayerBefore = await token.balanceOf(relayer)
      const ethBalanceOperatorBefore = await web3.eth.getBalance(operator)
      const balanceReceiverBefore = await token.balanceOf(toFixedHex(recipient, 20))
      const ethBalanceReceiverBefore = await web3.eth.getBalance(toFixedHex(recipient, 20))
      let isSpent = await tonic.isSpent(input.nullifierHash.toString(16).padStart(66, '0x00000'))
      expect(isSpent).to.equal(false)

      // Uncomment to measure gas usage
      // gas = await tonic.withdraw.estimateGas(proof, publicSignals, { from: relayer, gasPrice: '0' })
      // console.log('withdraw gas:', gas)
      const args = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund),
      ]
      const { logs } = await tonic.withdraw(proof, ...args, { value: refund, from: relayer, gasPrice: '0' })
      console.log('withdraw done')

      const balanceTonicAfter = await token.balanceOf(tonic.address)
      const balanceRelayerAfter = await token.balanceOf(relayer)
      const ethBalanceOperatorAfter = await web3.eth.getBalance(operator)
      const balanceReceiverAfter = await token.balanceOf(toFixedHex(recipient, 20))
      const ethBalanceReceiverAfter = await web3.eth.getBalance(toFixedHex(recipient, 20))
      const feeBN = toBN(fee.toString())
      expect(balanceTonicAfter).should.be.eq.BN(toBN(balanceTonicBefore).sub(toBN(tokenDenomination)))
      expect(balanceRelayerAfter).should.be.eq.BN(toBN(balanceRelayerBefore))
      expect(ethBalanceOperatorAfter).should.be.eq.BN(toBN(ethBalanceOperatorBefore).add(feeBN))
      expect(balanceReceiverAfter).should.be.eq.BN(toBN(balanceReceiverBefore).add(toBN(tokenDenomination)))
      expect(ethBalanceReceiverAfter).should.be.eq.BN(toBN(ethBalanceReceiverBefore).add(toBN(refund)).sub(feeBN))

      expect(logs[0].event).to.equal('Withdrawal')
      expect(logs[0].args.nullifierHash).should.be.eq.BN(toBN(input.nullifierHash.toString()))
      expect(logs[0].args.relayer).should.be.eq.BN(operator)
      expect(logs[0].args.fee).should.be.eq.BN(feeBN)
      isSpent = await tonic.isSpent(input.nullifierHash.toString(16).padStart(66, '0x00000'))
      expect(isSpent).to.equal(true)
    })
  })

  afterEach(async () => {
    await revertSnapshot(snapshotId.result)
    // eslint-disable-next-line require-atomic-updates
    snapshotId = await takeSnapshot()
    tree = new MerkleTree(levels)
  })
})
