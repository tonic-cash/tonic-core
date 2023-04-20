import { BigNumber } from '@ethersproject/bignumber'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import MerkleTree from 'fixed-merkle-tree'
import { ethers } from 'hardhat'

import Hasher from '../build/Hasher.json'
import { MerkleTreeWithHistoryMock } from '../typechain-types'
import { revertToSnapshot, takeSnapshot } from './utils/snapshot'

chai.use(chaiAsPromised)
chai.should()

const snarkjs = require('snarkjs')
const bigInt = snarkjs.bigInt

const { ETH_AMOUNT, MERKLE_TREE_HEIGHT } = process.env

function toFixedHex(value: BigNumber | any, length = 64): string {
  if (BigNumber.isBigNumber(value)) {
    const hexValue = value.toHexString().slice(2)
    const paddedValue = hexValue.padStart(length, '0')
    return '0x' + paddedValue
  } else {
    let str = bigInt(value).toString(16)
    length = length / 2
    while (str.length < length * 2) str = '0' + str
    str = '0x' + str
    return str
  }
}

describe('MerkleTreeWithHistory', () => {
  let merkleTreeWithHistory: MerkleTreeWithHistoryMock
  let hasherInstance: any
  let levels = Number(MERKLE_TREE_HEIGHT) || 16
  const value = ETH_AMOUNT || ethers.utils.parseEther('1').toString()
  let snapshotId: string
  let tree: MerkleTree
  let sender: SignerWithAddress

  before(async () => {
    ;[sender] = await ethers.getSigners()
    tree = new MerkleTree(levels)
    hasherInstance = await (await ethers.getContractFactory(Hasher.abi, Hasher.bytecode)).deploy()
    merkleTreeWithHistory = (await (
      await ethers.getContractFactory('MerkleTreeWithHistoryMock')
    ).deploy(levels, hasherInstance.address)) as MerkleTreeWithHistoryMock
    snapshotId = await ethers.provider.send('evm_snapshot', [])
  })

  describe('#constructor', () => {
    it('should initialize', async () => {
      const zeroValue = await merkleTreeWithHistory.ZERO_VALUE()
      const firstSubtree = await merkleTreeWithHistory.filledSubtrees(0)
      chai.expect(firstSubtree).to.equal(toFixedHex(zeroValue))
      const firstZero = await merkleTreeWithHistory.zeros(0)
      chai.expect(firstZero).to.equal(toFixedHex(zeroValue))
    })
  })

  describe('#insert', () => {
    it('should insert', async () => {
      let rootFromContract

      for (let i = 1; i < 11; i++) {
        await merkleTreeWithHistory.insert(toFixedHex(BigNumber.from(i)))
        tree.insert(BigNumber.from(i))
        rootFromContract = await merkleTreeWithHistory.getLastRoot()
        chai.expect(toFixedHex(tree.root())).to.equal(rootFromContract.toString())
      }
    })

    it('should reject if tree is full', async () => {
      const levels = 6
      const merkleTreeWithHistory = await (
        await ethers.getContractFactory('MerkleTreeWithHistoryMock')
      ).deploy(levels, hasherInstance.address)

      for (let i = 0; i < 2 ** levels; i++) {
        await merkleTreeWithHistory.insert(toFixedHex(BigNumber.from(i + 42))).should.be.fulfilled
      }

      let error = await merkleTreeWithHistory.insert(toFixedHex(BigNumber.from(1337))).should.be.rejected
      chai.expect(error.message).to.include('Merkle tree is full. No more leaves can be added')

      error = await merkleTreeWithHistory.insert(toFixedHex(BigNumber.from(1))).should.be.rejected
      chai.expect(error.message).to.include('Merkle tree is full. No more leaves can be added')
    })
  })

  describe('#isKnownRoot', () => {
    it('should work', async () => {
      for (let i = 1; i < 5; i++) {
        await merkleTreeWithHistory.insert(toFixedHex(BigNumber.from(i)), { from: sender.address })
        await tree.insert(i)
        const isKnown = await merkleTreeWithHistory.isKnownRoot(toFixedHex(tree.root()))
        expect(isKnown).to.be.true
      }

      await merkleTreeWithHistory.insert(toFixedHex(BigNumber.from(42)), { from: sender.address })
      // check outdated root
      const isKnown = await merkleTreeWithHistory.isKnownRoot(toFixedHex(tree.root()))
      expect(isKnown).to.be.true
    })

    it('should not return uninitialized roots', async () => {
      await merkleTreeWithHistory.insert(toFixedHex(BigNumber.from(42)), { from: sender.address })
      const isKnown = await merkleTreeWithHistory.isKnownRoot(toFixedHex(BigNumber.from(0)))
      expect(isKnown).to.be.false
    })
  })

  afterEach(async () => {
    await revertToSnapshot(snapshotId)
    snapshotId = await takeSnapshot()
    tree = new MerkleTree(levels)
  })
})
