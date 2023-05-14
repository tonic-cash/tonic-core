// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import './libraries/Tonic.sol';
import './interfaces/IToken.sol';
import './interfaces/IKIP7Receiver.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

contract KIP7Tonic is Tonic, IKIP7Receiver {
  using SafeERC20 for IERC20;
  IERC20 public token;

  function onKIP7Received(address, address, uint256, bytes memory) external pure returns (bytes4) {
    return 0x9d188c22;
  }

  constructor(
    IVerifier _verifier,
    IHasher _hasher,
    uint256 _denomination,
    uint32 _merkleTreeHeight,
    IERC20 _token,
    address payable _feePolicyManagerAddress
  ) Tonic(_verifier, _hasher, _denomination, _merkleTreeHeight, _feePolicyManagerAddress) {
    token = _token;
  }

  function _processDeposit() internal override {
    require(msg.value == 0, 'ETH value is supposed to be 0 for ERC20 instance');
    token.safeTransferFrom(msg.sender, address(this), denomination);
  }

  function _processWithdraw(
    address payable _recipient,
    address payable _relayer,
    uint256 _relayerFee,
    uint256 _refund
  ) internal override {
    require(msg.value == _refund, 'Incorrect refund amount received by the contract');

    uint256 treasuryFee = (denomination * _feeNumerator()) / _feeDenominator();
    uint256 recipientAmount = denomination - treasuryFee - _relayerFee;

    token.safeTransfer(_recipient, recipientAmount);

    if (treasuryFee > 0) {
      token.safeTransfer(_treasury(), treasuryFee);
    }

    if (_relayerFee > 0) {
      token.safeTransfer(_relayer, _relayerFee);
    }

    if (_refund > 0) {
      (bool success, ) = _recipient.call{ value: _refund }('');
      if (!success) {
        // let's return _refund back to the relayer
        _relayer.transfer(_refund);
      }
    }
  }

  // Only 1) native token and 2) contract-based tokens that is not deposit token, just in case for airdrops!
  receive() external payable {}

  function transfer(address _recipient, uint256 _amount) external onlyOwner {
    payable(_recipient).transfer(_amount);
  }

  function transfer(address _recipient, address _tokenAddr, uint256 _amount) external onlyOwner {
    require(_tokenAddr != address(token), 'token address should not be the same as deposit token');
    IToken transferableToken = IToken(_tokenAddr);
    transferableToken.transfer(_recipient, _amount);
  }
}
