// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

interface IToken {
  function transfer(address to, uint256 amount) external returns (bool);
}
