// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LeakyVault} from "../../contracts/demo-target/LeakyVault.sol";

/** Minimal mock ERC20 so the vault has real balances to be drained. */
contract MockUSDC {
    string public name = "Mock USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address t, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal"); balanceOf[msg.sender] -= a; balanceOf[t] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a && allowance[f][msg.sender] >= a, "no");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/**
 * Deploys the vulnerable LeakyVault to a local chain and seeds it with a
 * victim deposit, so a company can "submit" the vault address to monbounty and
 * a hunter can prove the drain against a real deployment.
 *
 *   forge script demo/web3/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 */
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        LeakyVault vault = new LeakyVault(address(usdc));
        // Seed a victim deposit so there is $1,000 to steal.
        address victim = msg.sender;
        usdc.mint(victim, 1_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000e6);
        vm.stopBroadcast();

        console.log("MOCK_USDC", address(usdc));
        console.log("LEAKY_VAULT", address(vault));
        console.log("VAULT_BALANCE", usdc.balanceOf(address(vault)));
    }
}
