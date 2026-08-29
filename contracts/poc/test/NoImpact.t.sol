// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ImpactProof} from "../src/ImpactProof.sol";
import {VaultBank} from "../../demo-target/VaultBank.sol";

contract StubToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a && allowance[f][msg.sender] >= a, "no");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    function transfer(address t, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a; balanceOf[t] += a; return true;
    }
}

/**
 * A hunter claiming "critical" for the rounding bug. Real finding, but it moves
 * no value -- the harness must refuse to award it a band on this evidence.
 */
contract NoImpact is ImpactProof {
    VaultBank bank; StubToken tok;
    address user = address(0xD2);
    address atk  = address(0xBAD);

    function setUp() public {
        tok = new StubToken();
        bank = new VaultBank(address(tok));
        tok.mint(user, 50e6);
        vm.startPrank(user);
        tok.approve(address(bank), type(uint256).max);
        bank.deposit(50e6);
        vm.stopPrank();
    }

    function target()   public view override returns (address) { return address(bank); }
    function asset()    public view override returns (address) { return address(tok); }
    function victim()   public view override returns (address) { return user; }
    function attacker() public view override returns (address) { return atk; }

    function exploit() public override { /* reads state, changes nothing */ bank.totalDeposited(); }

    function withdraw(address who) public override {
        uint256 b = bank.balance(who);
        vm.prank(who);
        bank.withdraw(b);
    }
}
