// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * LeakyVault — second demo target with a genuinely exploitable critical, unlike
 * VaultBank whose 0.8 underflow check happens to neutralise its reentrancy.
 * Exists so the impact harness has a finding it can classify as CRITICAL, not
 * just one it correctly rejects.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract LeakyVault {
    IERC20 public immutable token;
    mapping(address => uint256) public balance;

    constructor(address _token) { token = IERC20(_token); }

    function deposit(uint256 amount) external {
        require(token.transferFrom(msg.sender, address(this), amount), "xfer");
        balance[msg.sender] += amount;
    }

    function withdraw(uint256 amount) external {
        require(balance[msg.sender] >= amount, "insufficient");
        balance[msg.sender] -= amount;
        require(token.transfer(msg.sender, amount), "xfer");
    }

    // BUG (missing access control): drains the entire vault to an arbitrary
    // address. No owner check at all — any caller empties it.
    function rescueTo(address to) external {
        token.transfer(to, token.balanceOf(address(this)));
    }
}
