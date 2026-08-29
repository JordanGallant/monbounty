// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SubmissionRegistry} from "../SubmissionRegistry.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "bal");
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract SubmissionRegistryTest is Test {
    SubmissionRegistry reg;
    MockUSDC usdc;

    address platform = address(this);      // registry owner (records payments)
    address treasury = address(0xA8);
    address company  = address(0xC0FFEE);
    address ruler    = address(0xC11EE5);      // company's triager agent
    address hunter   = address(0x40FF1);

    bytes32 constant BOUNTY = keccak256("monad-escrow-demo");
    bytes32 constant SUB    = keccak256("sub-1");

    uint256 constant M = 1e6;              // USDC has 6 decimals

    function _tiers() internal pure returns (uint256[5] memory t) {
        t[0] = 50_000 * M; t[1] = 10_000 * M; t[2] = 5_000 * M; t[3] = 1_000 * M; t[4] = 0;
    }

    function setUp() public {
        usdc = new MockUSDC();
        reg = new SubmissionRegistry(address(usdc), treasury);
        reg.createBounty(BOUNTY, ruler, keccak256("rules-v1"), _tiers(), 7 days);

        usdc.mint(company, 100_000 * M);
        vm.startPrank(company);
        usdc.approve(address(reg), type(uint256).max);
        reg.fundBounty(BOUNTY, 60_000 * M);
        vm.stopPrank();
    }

    /// The vulnerability that matters: company reward money must never be
    /// spendable as hunter bond collateral.
    function test_PoolIsNotSpendableAsBondCollateral() public {
        assertEq(reg.pooled(), 60_000 * M);
        assertEq(reg.unassigned(), 0, "pool must not count as unassigned");

        // No x402 payment has landed, so recording a bond must fail even though
        // the contract visibly holds 60k of the company's money.
        vm.expectRevert(abi.encodeWithSelector(SubmissionRegistry.Underfunded.selector, 0, 10 * M));
        reg.record(SUB, hunter, BOUNTY, 10 * M, keccak256("c"));
    }

    function _bond(bytes32 id, uint256 amt) internal {
        usdc.mint(address(reg), amt);              // simulates x402 settlement
        reg.record(id, hunter, BOUNTY, amt, keccak256(abi.encode(id)));
    }

    function test_ReservationCapsConcurrentSubmissions() public {
        // Pool 60k, critical 50k -> exactly one submission can be outstanding.
        assertTrue(reg.canAcceptSubmission(BOUNTY));
        _bond(SUB, 10 * M);
        assertFalse(reg.canAcceptSubmission(BOUNTY), "second must not be acceptable");

        usdc.mint(address(reg), 10 * M);
        vm.expectRevert(abi.encodeWithSelector(SubmissionRegistry.PoolExhausted.selector, 10_000 * M, 50_000 * M));
        reg.record(keccak256("sub-2"), hunter, BOUNTY, 10 * M, keccak256("c2"));
    }

    function test_ValidCriticalPaysAwardAndRefundsBondAtomically() public {
        _bond(SUB, 10 * M);
        vm.prank(ruler);
        reg.grade(SUB, SubmissionRegistry.Verdict.Valid, 0);   // tier 0 = critical

        uint256 before = usdc.balanceOf(hunter);
        reg.settle(SUB);
        assertEq(usdc.balanceOf(hunter) - before, 50_010 * M, "award + bond in one tx");

        (uint256 free, uint256 reserved) = reg.poolRemaining(BOUNTY);
        assertEq(reserved, 0);
        assertEq(free, 10_000 * M, "pool decremented by exactly the tier");
        assertEq(reg.pooled(), 10_000 * M);
    }

    /// A company grading a critical as "low" pays the low tier -- but it cannot
    /// invent a number that was never in the committed table.
    function test_AwardAlwaysComesFromTheCommittedTable() public {
        _bond(SUB, 10 * M);
        vm.prank(ruler);
        reg.grade(SUB, SubmissionRegistry.Verdict.Valid, 3);   // tier 3 = low
        reg.settle(SUB);
        assertEq(usdc.balanceOf(hunter), 1_010 * M, "low tier exactly, bond returned");
    }

    function test_SlopSlashesBondAndPaysNoAward() public {
        _bond(SUB, 10 * M);
        vm.prank(ruler);
        reg.grade(SUB, SubmissionRegistry.Verdict.Slop, 4);
        reg.settle(SUB);
        assertEq(usdc.balanceOf(treasury), 10 * M, "bond slashed to treasury");
        assertEq(usdc.balanceOf(hunter), 0);
        assertEq(reg.pooled(), 60_000 * M, "pool untouched");
    }

    function test_OnlyTheBountyRulerCanGrade() public {
        _bond(SUB, 10 * M);
        vm.expectRevert(SubmissionRegistry.NotRuler.selector);
        reg.grade(SUB, SubmissionRegistry.Verdict.Valid, 0);   // platform owner may not
    }

    function test_TimeoutRefundsBondAndUnlocksDisclosure() public {
        _bond(SUB, 10 * M);
        vm.expectRevert(SubmissionRegistry.DeadlineNotPassed.selector);
        reg.claimTimeout(SUB);

        vm.warp(block.timestamp + 7 days + 1);
        reg.claimTimeout(SUB);

        assertEq(usdc.balanceOf(hunter), 10 * M, "bond returned without company cooperation");
        (,,,,,,,,, bool disclosable) = _sub(SUB);
        assertTrue(disclosable, "hunter earns the right to publish");
        (, uint256 reserved) = reg.poolRemaining(BOUNTY);
        assertEq(reserved, 0, "reservation released");
    }

    function test_CannotDefundBountyWhileReportsArePending() public {
        _bond(SUB, 10 * M);
        vm.prank(ruler);
        vm.expectRevert(abi.encodeWithSelector(SubmissionRegistry.StillReserved.selector, 50_000 * M));
        reg.closeBounty(BOUNTY, company);
    }

    function test_NonMonotonicTiersRejected() public {
        uint256[5] memory bad = _tiers();
        bad[2] = 20_000 * M;                                   // medium > high
        vm.expectRevert(SubmissionRegistry.NonMonotonicTiers.selector);
        reg.createBounty(keccak256("b2"), ruler, keccak256("r"), bad, 1 days);
    }

    function test_RulesHashIsImmutable() public {
        (, bytes32 rulesHash,,,,) = reg.bounties(BOUNTY);
        assertEq(rulesHash, keccak256("rules-v1"));
        vm.expectRevert(SubmissionRegistry.BountyExists.selector);
        reg.createBounty(BOUNTY, ruler, keccak256("rules-v2"), _tiers(), 1 days);
    }

    function _sub(bytes32 id) internal view
        returns (address, uint256, bytes32, bytes32, uint64, SubmissionRegistry.Verdict, bool, uint8, uint256, bool)
    { return reg.submissions(id); }
}
