// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import './libraries/Tonic.sol';
import './interfaces/IToken.sol';
import './interfaces/IKIP7Receiver.sol';

contract ETHTonic is Tonic, IKIP7Receiver {
  constructor(
    IVerifier _verifier,
    IHasher _hasher,
    uint256 _denomination,
    uint32 _merkleTreeHeight,
    address payable _feePolicyManagerAddress
  ) Tonic(_verifier, _hasher, _denomination, _merkleTreeHeight, _feePolicyManagerAddress) {}

  function onKIP7Received(address, address, uint256, bytes memory) external pure returns (bytes4) {
    return 0x9d188c22;
  }

  function _processDeposit() internal override {
    require(msg.value == denomination, 'Please send `mixDenomination` ETH along with transaction');
  }

  function _processWithdraw(
    address payable _recipient,
    address payable _relayer,
    uint256 _relayerFee,
    uint256 _refund
  ) internal override {
    // sanity checks
    require(msg.value == 0, 'Message value is supposed to be zero for ETH instance');
    require(_refund == 0, 'Refund value is supposed to be zero for ETH instance');

    uint256 treasuryFee = (denomination * _feeNumerator()) / _feeDenominator();
    uint256 recipientAmount = denomination - treasuryFee - _relayerFee;

    (bool success, ) = _recipient.call{ value: recipientAmount }('');
    require(success, 'payment to _recipient did not go thru');

    if (treasuryFee > 0) {
      (bool feeSuccess, ) = _treasury().call{ value: treasuryFee }('');
      require(feeSuccess, 'payment to treasury did not go thru');
    }

    if (_relayerFee > 0) {
      (bool relayerSuccess, ) = _relayer.call{ value: _relayerFee }('');
      require(relayerSuccess, 'payment to _relayer did not go thru');
    }
  }

  // Only contract-based tokens, just in case for airdrops!
  receive() external payable {}

  function transfer(address _recipient, address _token, uint256 _amount) external onlyOwner {
    IToken token = IToken(_token);
    token.transfer(_recipient, _amount);
  }
}
