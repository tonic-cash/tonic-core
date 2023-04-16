// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IToken.sol";

contract TonicFeePolicyManager is Ownable {
    uint256 public feeNumerator;
    uint256 public feeDenominator;
    address public treasury;

    constructor(uint256 _feeNumerator, uint256 _feeDenominator, address _treasury) {
        feeNumerator = _feeNumerator;
        feeDenominator = _feeDenominator;
        treasury = _treasury;
    }

    event FeePolicyUpdated(uint256 feeNumerator, uint256 feeDenominator);
    event TreasuryAddressUpdated(address treasury);

    function setFeePolicy(uint256 _feeNumerator, uint256 _feeDenominator) external onlyOwner {
        require(_feeNumerator <= _feeDenominator, "numerator should be less than or equal to denominator");
        feeNumerator = _feeNumerator;
        feeDenominator = _feeDenominator;
        emit FeePolicyUpdated(_feeNumerator, _feeDenominator);
    }

    function setTreasuryAddress(address _treasury) external onlyOwner {
        require(_treasury != address(0), "treasury address should not be zero address");
        treasury = _treasury;
        emit TreasuryAddressUpdated(_treasury);
    }

    // Just in case!
    receive() external payable {}

    function transfer(address _recipient, uint256 _amount) external onlyOwner {
        payable(_recipient).transfer(_amount);
    }

    function transfer(address _recipient, address _token, uint256 _amount) external onlyOwner {
        IToken token = IToken(_token);
        token.transfer(_recipient, _amount);
    }
}
