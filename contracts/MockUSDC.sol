// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Mock USDC token for testing (6 decimals like real USDC)
 */
contract MockUSDC is ERC20 {
    uint8 private constant _decimals = 6;

    constructor() ERC20("Mock USDC", "mUSDC") {
        // Mint 1 billion tokens to deployer for testing
        _mint(msg.sender, 1_000_000_000 * 10**decimals());
    }

    function decimals() public pure override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Mint tokens to any address (for testing)
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from any address (for testing)
     */
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

