// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

contract BadRecipient {
  fallback() external {
    require(false, 'this contract does not accept ETH');
  }
}
