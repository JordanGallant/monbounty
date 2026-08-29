// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

interface IAsset {
    function balanceOf(address) external view returns (uint256);
}

/**
 * Harness that turns a proof-of-concept into a severity band.
 *
 * The hunter implements `exploit()` and nothing else. Every assertion and every
 * balance measurement lives here, in code the company and the platform can read
 * before the bounty opens -- because a hunter who supplied their own assertions
 * would simply be grading their own finding, which is the exact conflict this
 * whole system exists to remove.
 *
 * The band is not argued, it is observed: the harness watches what moved and
 * maps that to the impact catalogue committed in the bounty's rulesHash.
 *
 *   attacker gains protocol/victim funds        -> theft-user-funds     CRITICAL
 *   victim can never withdraw again             -> permanent-freeze     CRITICAL
 *   claims exceed assets held                   -> insolvency           CRITICAL
 *   victim blocked now, recovers later          -> temporary-freeze     HIGH
 *   victim harmed, attacker gains nothing       -> griefing             MEDIUM
 *   nothing moved                               -> (no impact proven)   REJECTED
 */
abstract contract ImpactProof is Test {
    // ── the hunter supplies these ──────────────────────────────────────────
    function target()   public view virtual returns (address);
    function asset()    public view virtual returns (address);
    function victim()   public view virtual returns (address);
    function attacker() public view virtual returns (address);

    /** Set up protocol state as it exists in production. */
    function stage() public virtual {}

    /** The exploit itself. The only place hunter-controlled logic runs. */
    function exploit() public virtual;

    /** Optional: how a healthy user withdraws. Enables the freeze bands. */
    function withdraw(address who) public virtual { who; revert("no-withdraw-path"); }

    /** Optional: total user claims, for the insolvency band. */
    function totalClaims() public view virtual returns (uint256) { return 0; }

    // ── measurement (hunter cannot override: non-virtual) ──────────────────

    string public provenImpact;
    uint256 public valueMoved;

    function _bal(address who) internal view returns (uint256) {
        return asset() == address(0) ? who.balance : IAsset(asset()).balanceOf(who);
    }

    function _withdrawWorks(address who) internal returns (bool) {
        uint256 snap = vm.snapshotState();
        bool ok;
        try this._callWithdraw(who) { ok = true; } catch { ok = false; }
        vm.revertToState(snap);
        return ok;
    }

    function _callWithdraw(address who) external { withdraw(who); }

    function test_ProveImpact() public {
        stage();

        uint256 attackerBefore = _bal(attacker());
        uint256 victimBefore   = _bal(victim());
        uint256 targetBefore   = _bal(target());
        bool    withdrawBefore = _withdrawWorks(victim());

        vm.startPrank(attacker());
        exploit();
        vm.stopPrank();

        uint256 attackerAfter = _bal(attacker());
        uint256 victimAfter   = _bal(victim());
        uint256 targetAfter   = _bal(target());

        uint256 gained = attackerAfter > attackerBefore ? attackerAfter - attackerBefore : 0;
        uint256 lost   = (victimBefore + targetBefore) > (victimAfter + targetAfter)
            ? (victimBefore + targetBefore) - (victimAfter + targetAfter) : 0;

        // CRITICAL -- value left the protocol and landed with the attacker.
        if (gained > 0 && lost >= gained) {
            provenImpact = "theft-user-funds";
            valueMoved = gained;
            _emit();
            return;
        }

        // CRITICAL -- claims now exceed assets.
        uint256 claims = totalClaims();
        if (claims > 0 && claims > targetAfter) {
            provenImpact = "insolvency";
            valueMoved = claims - targetAfter;
            _emit();
            return;
        }

        // Freeze bands only mean something if withdrawal worked beforehand.
        if (withdrawBefore && !_withdrawWorks(victim())) {
            vm.warp(block.timestamp + 365 days);
            vm.roll(block.number + 2_600_000);
            if (_withdrawWorks(victim())) {
                provenImpact = "temporary-freeze";
            } else {
                provenImpact = "permanent-freeze";
            }
            valueMoved = victimBefore;
            _emit();
            return;
        }

        // MEDIUM -- the victim is worse off and the attacker profited nothing.
        if (lost > 0 && gained == 0) {
            provenImpact = "griefing";
            valueMoved = lost;
            _emit();
            return;
        }

        revert("IMPACT_NOT_PROVEN: exploit ran but moved no value and blocked no withdrawal");
    }

    function _emit() internal {
        console.log("PROVEN_IMPACT", provenImpact);
        console.log("VALUE_MOVED", valueMoved);
    }
}
