// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * Escrow + receipt log for x402-priced vulnerability intake.
 *
 * Set this contract as the x402 `payTo` address. The facilitator's
 * transferWithAuthorization lands USDC here, then the resource server calls
 * `record` to bind that transfer to a report. Until a triager rules, the bond
 * is held by the contract rather than by whoever runs the server -- which is
 * the whole difference between "we promise to refund" and "the refund is
 * enforceable".
 *
 * Deliberately NOT upgradeable and NOT pausable: a hunter's bond should not be
 * freezable by the operator, since that reintroduces exactly the trust the
 * bond was meant to remove.
 */
contract SubmissionRegistry {
    enum Verdict { Pending, Valid, Duplicate, OutOfScope, Slop }

    struct Submission {
        address payer;
        uint256 amount;      // total bonded, in USDC base units
        bytes32 contentHash;
        bytes32 program;
        uint64  submittedAt;
        Verdict verdict;
        bool    settled;     // refunded or slashed
        uint8   tier;        // severity index chosen by the verdict
        uint256 award;       // USDC owed from the bounty pool on settle
        bool    disclosable; // SLA blown: hunter may publish
    }

    /**
     * A company's committed offer.
     *
     * `rulesHash` is the keccak of the canonical scope + severity rubric +
     * payout table the hunter was shown. Committing it at creation is what
     * stops the goalposts moving: a company that re-grades a finding after
     * reading it is now contradicting a hash it published beforehand.
     *
     * `tiers` is indexed by severity (0 critical .. 4 informational). The
     * verdict picks an impact category, the category fixes the severity, and
     * the severity indexes this array -- so the discretion is in the judgement
     * and never in the arithmetic.
     */
    struct Bounty {
        address ruler;        // the company's triager agent
        bytes32 rulesHash;
        uint256 pool;         // escrowed USDC available to pay awards
        uint256 reserved;     // locked against submissions awaiting a verdict
        uint64  slaSeconds;   // verdict deadline, per submission
        bool    active;
    }

    mapping(bytes32 => Bounty) public bounties;
    mapping(bytes32 => uint256[5]) internal _tiers;
    bytes32[] public bountyIds;

    IERC20  public immutable usdc;
    address public immutable treasury;   // receives slashed bonds
    address public owner;                // triager; can be a multisig

    mapping(bytes32 => Submission) public submissions;
    bytes32[] public submissionIds;

    event Recorded(bytes32 indexed id, address indexed payer, bytes32 indexed program, uint256 amount, bytes32 contentHash);
    event Topped(bytes32 indexed id, uint256 amount, uint256 total);
    event Ruled(bytes32 indexed id, Verdict verdict);
    event Refunded(bytes32 indexed id, address indexed payer, uint256 amount);
    event Slashed(bytes32 indexed id, uint256 amount);
    event OwnerChanged(address indexed from, address indexed to);
    event BountyCreated(bytes32 indexed bounty, address indexed ruler, bytes32 rulesHash, uint64 slaSeconds);
    event BountyFunded(bytes32 indexed bounty, address indexed from, uint256 amount, uint256 pool);
    event BountyClosed(bytes32 indexed bounty, uint256 refunded);
    event Graded(bytes32 indexed id, uint8 tier, uint256 award);
    event Awarded(bytes32 indexed id, address indexed hunter, uint256 amount);
    event SlaBreached(bytes32 indexed id, bytes32 indexed bounty);

    error NotOwner();
    error UnknownSubmission();
    error AlreadyExists();
    error AlreadySettled();
    error NotRuled();
    error ZeroAmount();
    error Underfunded(uint256 held, uint256 needed);
    error TransferFailed();
    error UnknownBounty();
    error BountyExists();
    error NotRuler();
    error PoolExhausted(uint256 available, uint256 needed);
    error BadTier();
    error NonMonotonicTiers();
    error DeadlineNotPassed();
    error StillReserved(uint256 reserved);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _usdc, address _treasury) {
        usdc = IERC20(_usdc);
        treasury = _treasury;
        owner = msg.sender;
    }

    modifier onlyRuler(bytes32 bounty) {
        if (msg.sender != bounties[bounty].ruler) revert NotRuler();
        _;
    }

    // --- company side -----------------------------------------------------

    /**
     * Publish a bounty: commit the rules, name the ruler, start the clock.
     *
     * Anyone may create one -- a bounty with no pool is worthless, so there is
     * nothing to gain by squatting, and gating creation would put the operator
     * back in the trust path.
     */
    function createBounty(
        bytes32 bounty,
        address ruler,
        bytes32 rulesHash,
        uint256[5] calldata tiers,
        uint64 slaSeconds
    ) external {
        if (bounties[bounty].ruler != address(0)) revert BountyExists();
        if (ruler == address(0)) revert NotRuler();
        // Monotonic, else "critical" could pay less than "low" and the rubric
        // would be decorative.
        for (uint256 i = 1; i < 5; i++) {
            if (tiers[i] > tiers[i - 1]) revert NonMonotonicTiers();
        }
        if (tiers[0] == 0) revert ZeroAmount();

        bounties[bounty] = Bounty({
            ruler: ruler,
            rulesHash: rulesHash,
            pool: 0,
            reserved: 0,
            slaSeconds: slaSeconds,
            active: true
        });
        _tiers[bounty] = tiers;
        bountyIds.push(bounty);
        emit BountyCreated(bounty, ruler, rulesHash, slaSeconds);
    }

    /**
     * Escrow reward money. Pulls USDC from the caller, so the company funds it
     * from its own wallet and the balance is verifiable by any hunter before
     * they spend a bond. This is the difference between a published reward
     * range and a solvent one.
     */
    function fundBounty(bytes32 bounty, uint256 amount) external {
        Bounty storage b = bounties[bounty];
        if (b.ruler == address(0)) revert UnknownBounty();
        if (amount == 0) revert ZeroAmount();
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        b.pool += amount;
        _pooled += amount;
        emit BountyFunded(bounty, msg.sender, amount, b.pool);
    }

    /**
     * Withdraw the unreserved remainder and stop accepting submissions.
     * Reserved funds stay locked: a company cannot defund a bounty out from
     * under reports it has already received but not yet graded.
     */
    function closeBounty(bytes32 bounty, address to) external onlyRuler(bounty) {
        Bounty storage b = bounties[bounty];
        if (b.reserved != 0) revert StillReserved(b.reserved);
        uint256 amount = b.pool;
        b.pool = 0;
        b.active = false;
        _pooled -= amount;
        if (amount > 0 && !usdc.transfer(to, amount)) revert TransferFailed();
        emit BountyClosed(bounty, amount);
    }

    /** Max payable award: the critical tier. */
    function maxAward(bytes32 bounty) public view returns (uint256) {
        return _tiers[bounty][0];
    }

    /**
     * What a hunter should check before bonding. False means the pool cannot
     * cover another worst-case award, so a valid critical could not be paid.
     */
    function canAcceptSubmission(bytes32 bounty) public view returns (bool) {
        Bounty storage b = bounties[bounty];
        if (!b.active) return false;
        return b.pool - b.reserved >= maxAward(bounty);
    }

    function tiersOf(bytes32 bounty) external view returns (uint256[5] memory) {
        return _tiers[bounty];
    }

    function poolRemaining(bytes32 bounty) external view returns (uint256 free, uint256 reserved) {
        Bounty storage b = bounties[bounty];
        return (b.pool - b.reserved, b.reserved);
    }

    function bountyCount() external view returns (uint256) {
        return bountyIds.length;
    }

    function setOwner(address next) external onlyOwner {
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /**
     * Bind an already-received x402 payment to a report.
     *
     * `unassigned()` is checked rather than trusting the caller, so the owner
     * cannot record submissions the contract was never actually paid for and
     * drain bonds belonging to other hunters.
     */
    function record(bytes32 id, address payer, bytes32 program, uint256 amount, bytes32 contentHash)
        external
        onlyOwner
    {
        if (amount == 0) revert ZeroAmount();
        if (submissions[id].payer != address(0)) revert AlreadyExists();
        uint256 free = unassigned();
        if (free < amount) revert Underfunded(free, amount);

        // Reserve the worst case now. A hunter who bonds must know the pool can
        // still pay a critical; without this the company could accept a hundred
        // bonds against enough money for one award.
        Bounty storage b = bounties[program];
        if (b.ruler == address(0)) revert UnknownBounty();
        uint256 need = maxAward(program);
        uint256 avail = b.pool - b.reserved;
        if (!b.active || avail < need) revert PoolExhausted(avail, need);
        b.reserved += need;

        submissions[id] = Submission({
            payer: payer,
            amount: amount,
            contentHash: contentHash,
            program: program,
            submittedAt: uint64(block.timestamp),
            verdict: Verdict.Pending,
            settled: false,
            tier: 0,
            award: 0,
            disclosable: false
        });
        submissionIds.push(id);
        _committed += amount;
        emit Recorded(id, payer, program, amount, contentHash);
    }

    /** Second gate (PoC) adds to the same submission's bond. */
    function topUp(bytes32 id, uint256 amount) external onlyOwner {
        Submission storage s = submissions[id];
        if (s.payer == address(0)) revert UnknownSubmission();
        if (s.settled) revert AlreadySettled();
        if (amount == 0) revert ZeroAmount();
        uint256 free = unassigned();
        if (free < amount) revert Underfunded(free, amount);

        s.amount += amount;
        _committed += amount;
        emit Topped(id, amount, s.amount);
    }

    /**
     * Grade a submission. Called by the bounty's own ruler -- the company's
     * triager agent -- not by the platform, so bounty402 is never the judge of
     * a dispute it has a fee interest in.
     *
     * `tier` is the severity index. The award is read from the table committed
     * at creation, so a company can argue about which impact a finding is, but
     * not about what that impact was promised to pay.
     */
    function grade(bytes32 id, Verdict v, uint8 tier) external {
        Submission storage s = submissions[id];
        if (s.payer == address(0)) revert UnknownSubmission();
        if (s.settled) revert AlreadySettled();
        if (v == Verdict.Pending) revert NotRuled();
        if (tier >= 5) revert BadTier();

        Bounty storage b = bounties[s.program];
        if (msg.sender != b.ruler) revert NotRuler();

        uint256 award = v == Verdict.Valid ? _tiers[s.program][tier] : 0;

        // Release the worst-case reservation, hold back only what is owed.
        uint256 held = maxAward(s.program);
        b.reserved = b.reserved >= held ? b.reserved - held : 0;
        b.reserved += award;

        s.verdict = v;
        s.tier = tier;
        s.award = award;
        emit Ruled(id, v);
        emit Graded(id, tier, award);
    }

    /**
     * The company went quiet. After the committed SLA a hunter takes their bond
     * back without anyone's cooperation, and earns the right to disclose --
     * which is the only leverage that has ever made bounty programs answer.
     */
    function claimTimeout(bytes32 id) external {
        Submission storage s = submissions[id];
        if (s.payer == address(0)) revert UnknownSubmission();
        if (s.settled) revert AlreadySettled();
        if (s.verdict != Verdict.Pending) revert AlreadySettled();

        Bounty storage b = bounties[s.program];
        if (block.timestamp < s.submittedAt + b.slaSeconds) revert DeadlineNotPassed();

        uint256 held = maxAward(s.program);
        b.reserved = b.reserved >= held ? b.reserved - held : 0;

        s.settled = true;
        s.disclosable = true;
        uint256 amount = s.amount;
        _committed -= amount;
        if (!usdc.transfer(s.payer, amount)) revert TransferFailed();

        emit SlaBreached(id, s.program);
        emit Refunded(id, s.payer, amount);
    }

    /**
     * Settle a ruled submission. Anyone may call this: once a verdict is on
     * chain the outcome is determined, so a hunter can collect their own
     * refund without waiting on the operator to act.
     */
    function settle(bytes32 id) external {
        Submission storage s = submissions[id];
        if (s.payer == address(0)) revert UnknownSubmission();
        if (s.settled) revert AlreadySettled();
        if (s.verdict == Verdict.Pending) revert NotRuled();

        s.settled = true;
        uint256 amount = s.amount;
        _committed -= amount;

        Bounty storage b = bounties[s.program];
        uint256 award = s.award;
        if (award > 0) {
            b.pool -= award;
            b.reserved -= award;
            _pooled -= award;
        }

        // Checked: an unchecked transfer would let a failed payout still mark
        // the submission settled, burning the hunter's bond on a token quirk.
        if (s.verdict == Verdict.Valid || s.verdict == Verdict.Duplicate) {
            if (!usdc.transfer(s.payer, amount)) revert TransferFailed();
            emit Refunded(id, s.payer, amount);
        } else {
            if (!usdc.transfer(treasury, amount)) revert TransferFailed();
            emit Slashed(id, amount);
        }

        // Bond and award move in one transaction: a hunter never has a valid
        // finding acknowledged and the money still outstanding.
        if (award > 0) {
            if (!usdc.transfer(s.payer, award)) revert TransferFailed();
            emit Awarded(id, s.payer, award);
        }
    }

    // --- accounting -------------------------------------------------------

    uint256 private _committed;
    uint256 private _pooled;

    /** USDC escrowed as company reward pools. */
    function pooled() external view returns (uint256) {
        return _pooled;
    }

    /** USDC held against open submissions. */
    function committed() external view returns (uint256) {
        return _committed;
    }

    /** USDC sitting in the contract that no submission has claimed yet. */
    function unassigned() public view returns (uint256) {
        return usdc.balanceOf(address(this)) - _committed - _pooled;
    }

    function submissionCount() external view returns (uint256) {
        return submissionIds.length;
    }
}
