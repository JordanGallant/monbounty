// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * VaultBank — a demo "company" contract for the hunter agent to analyse.
 * It has real, findable bugs. NOT part of bounty402 itself; it exists only as
 * a target so the bug-finding pipeline has something concrete to work on.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract VaultBank {
    IERC20 public immutable token;
    address public owner;
    mapping(address => uint256) public balance;
    uint256 public totalDeposited;

    constructor(address _token) {
        token = IERC20(_token);
        owner = msg.sender;
    }

    function deposit(uint256 amount) external {
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        balance[msg.sender] += amount;
        totalDeposited += amount;
    }

    // BUG 1 (reentrancy / CEI): pays out before updating state. A token with a
    // transfer hook (ERC-777 style) lets the recipient re-enter withdraw() and
    // drain the vault, because balance[msg.sender] is only zeroed afterwards.
    function withdraw(uint256 amount) external {
        require(balance[msg.sender] >= amount, "insufficient");
        require(token.transfer(msg.sender, amount), "transfer failed");
        balance[msg.sender] -= amount;
        totalDeposited -= amount;
    }

    // BUG 2 (access control): the modifier compares tx.origin, not msg.sender,
    // so any contract the owner is tricked into calling can invoke this while
    // tx.origin is still the owner. Should be `msg.sender == owner`.
    modifier onlyOwner() {
        require(tx.origin == owner, "not owner");
        _;
    }

    function sweep(address to) external onlyOwner {
        token.transfer(to, token.balanceOf(address(this)));
    }

    // BUG 3 (rounding / precision): interest divides before multiplying, so any
    // balance below 100 accrues zero interest and the fraction is lost. Out of
    // scope for the demo program, included to test scope filtering.
    function accrue(address user, uint256 rateBps) external onlyOwner {
        uint256 interest = (balance[user] / 10_000) * rateBps;
        balance[user] += interest;
    }
}
