// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SubmissionRegistry} from "../SubmissionRegistry.sol";
import {HunterReputation} from "../HunterReputation.sol";

/**
 * Deploys the on-chain settlement layer:
 *   - SubmissionRegistry: escrow pool + bond binding + atomic grade/settle (#1,#2)
 *     with commit-reveal priority (#3).
 *   - HunterReputation: on-chain track record, optional ERC-8004 mirror.
 *
 * env:
 *   DEPLOYER_PK             the treasury/platform key (pays gas, becomes owner)
 *   USDC_ADDRESS            the network's USDC
 *   TREASURY_SLASH_ADDRESS  where slashed bonds go (typically the treasury EOA)
 *   REP_REPUTATION_REGISTRY optional ERC-8004 reputation registry (0x0 to skip)
 *   REP_IDENTITY_REGISTRY   optional ERC-8004 identity registry (0x0 to skip)
 *
 *   forge script contracts/script/Deploy.s.sol:Deploy \
 *     --rpc-url $RPC --broadcast
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address slashTo = vm.envAddress("TREASURY_SLASH_ADDRESS");
        address repReg = vm.envOr("REP_REPUTATION_REGISTRY", address(0));
        address idReg = vm.envOr("REP_IDENTITY_REGISTRY", address(0));

        vm.startBroadcast(pk);
        SubmissionRegistry reg = new SubmissionRegistry(usdc, slashTo);
        HunterReputation rep = new HunterReputation(repReg, idReg);
        vm.stopBroadcast();

        console2.log("USDC              ", usdc);
        console2.log("SubmissionRegistry", address(reg));
        console2.log("HunterReputation  ", address(rep));
    }
}
