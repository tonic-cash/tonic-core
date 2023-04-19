// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract DAIMock is ERC20("DAIMock", "DAIM") {
  function mint(address account, uint256 amount) public {
    _mint(account, amount);
  }
}
