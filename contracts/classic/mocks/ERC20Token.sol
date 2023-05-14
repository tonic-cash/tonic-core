// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';

contract ERC20Token is ERC20 {
  uint8 private _decimals;

  constructor(
    string memory name,
    string memory symbol,
    uint8 intendedDecimals,
    uint256 initialSupply,
    address owner
  ) ERC20(name, symbol) {
    _decimals = intendedDecimals;
    _mint(owner, initialSupply * 10 ** uint256(decimals()));
  }

  function decimals() public view override returns (uint8) {
    return _decimals;
  }

  function mint(address account, uint256 amount) public {
    _mint(account, amount);
  }
}
