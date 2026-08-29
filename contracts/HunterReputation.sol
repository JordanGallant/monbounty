// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ERC-8004 Reputation Registry (subset this contract calls).
interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function getIdentityRegistry() external view returns (address);
}

/// ERC-8004 Identity Registry (subset).
interface IIdentityRegistry {
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/**
 * Hunter track record for bounty402, published as ERC-8004 feedback.
 *
 * Two jobs, deliberately separable:
 *
 *  1. Keep a self-contained per-hunter tally on chain, so the bond discount a
 *     hunter is quoted can be checked by anyone against the same numbers the
 *     server used. Without this the discount is just the operator's word.
 *
 *  2. Mirror each verdict into an ERC-8004 ReputationRegistry as feedback
 *     against the hunter's agentId, so the record is portable to any other
 *     platform that reads 8004 rather than being locked in here.
 *
 * Job 2 is optional: if no registry is configured, or a hunter has no agentId,
 * the tally still works. A bug bounty platform that hard-required an 8004
 * registration would exclude exactly the independent researchers it wants.
 */
contract HunterReputation {
    enum Verdict { Valid, Duplicate, OutOfScope, Slop }

    struct Record {
        uint64  submitted;
        uint64  valid;
        uint64  duplicate;
        uint64  outOfScope;
        uint64  slop;
        uint256 bondedAtomic;   // total bonded, USDC base units
        uint256 refundedAtomic;
        uint256 slashedAtomic;
        uint256 paidOutAtomic;  // bounty awarded, USDC base units
        uint64  firstSeen;
        uint64  lastSeen;
    }

    /// Feedback is scored -100..100 with 0 decimals; ERC-8004 leaves scale to the client.
    int128 private constant SCORE_VALID       = 100;
    int128 private constant SCORE_DUPLICATE   = 25;
    int128 private constant SCORE_OUT_OF_SCOPE = -25;
    int128 private constant SCORE_SLOP        = -100;
    uint8  private constant SCORE_DECIMALS    = 0;

    string public constant TAG_DOMAIN = "security-research";

    address public owner;
    IReputationRegistry public reputationRegistry; // optional
    IIdentityRegistry  public identityRegistry;    // optional

    mapping(address => Record) private _records;
    mapping(address => uint256) public agentIdOf;   // 0 = unregistered
    address[] private _hunters;
    mapping(address => bool) private _known;

    event Recorded(address indexed hunter, bytes32 indexed reportId, uint256 bondedAtomic);
    event Ruled(address indexed hunter, bytes32 indexed reportId, Verdict verdict, uint256 payoutAtomic);
    event FeedbackPublished(address indexed hunter, uint256 indexed agentId, int128 value);
    event FeedbackSkipped(address indexed hunter, string reason);
    event AgentLinked(address indexed hunter, uint256 indexed agentId);
    event RegistriesSet(address reputationRegistry, address identityRegistry);
    event OwnerChanged(address indexed from, address indexed to);

    error NotOwner();
    error ZeroHunter();
    error AlreadyRuled();
    error UnknownReport();
    error WalletMismatch(address expected, address got);

    mapping(bytes32 => address) public reportHunter;
    mapping(bytes32 => bool) public reportRuled;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address reputationRegistry_, address identityRegistry_) {
        owner = msg.sender;
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
        emit RegistriesSet(reputationRegistry_, identityRegistry_);
    }

    function setOwner(address next) external onlyOwner {
        emit OwnerChanged(owner, next);
        owner = next;
    }

    function setRegistries(address reputationRegistry_, address identityRegistry_) external onlyOwner {
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
        emit RegistriesSet(reputationRegistry_, identityRegistry_);
    }

    /**
     * Link a hunter address to an ERC-8004 agentId.
     *
     * Checked against the identity registry when one is configured: without
     * this a hunter could claim someone else's agentId and have their slop
     * scored against a stranger's reputation.
     */
    function linkAgent(address hunter, uint256 agentId) external onlyOwner {
        if (hunter == address(0)) revert ZeroHunter();
        if (address(identityRegistry) != address(0) && agentId != 0) {
            address wallet = identityRegistry.getAgentWallet(agentId);
            if (wallet != hunter) revert WalletMismatch(hunter, wallet);
        }
        agentIdOf[hunter] = agentId;
        emit AgentLinked(hunter, agentId);
    }

    /// Called when a bond settles, before any verdict exists.
    function recordSubmission(bytes32 reportId, address hunter, uint256 bondedAtomic)
        external
        onlyOwner
    {
        if (hunter == address(0)) revert ZeroHunter();
        Record storage r = _records[hunter];
        if (!_known[hunter]) {
            _known[hunter] = true;
            _hunters.push(hunter);
            r.firstSeen = uint64(block.timestamp);
        }
        // Re-recording the same id would let the owner inflate a tally, so the
        // first write wins and later ones only top up the bond.
        if (reportHunter[reportId] == address(0)) {
            reportHunter[reportId] = hunter;
            r.submitted += 1;
        }
        r.bondedAtomic += bondedAtomic;
        r.lastSeen = uint64(block.timestamp);
        emit Recorded(hunter, reportId, bondedAtomic);
    }

    /// Called once per report when triage rules on it.
    function rule(bytes32 reportId, Verdict verdict, uint256 payoutAtomic, string calldata feedbackURI)
        external
        onlyOwner
    {
        address hunter = reportHunter[reportId];
        if (hunter == address(0)) revert UnknownReport();
        if (reportRuled[reportId]) revert AlreadyRuled();
        reportRuled[reportId] = true;

        Record storage r = _records[hunter];
        uint256 bonded = r.bondedAtomic;

        int128 score;
        if (verdict == Verdict.Valid) {
            r.valid += 1;
            r.paidOutAtomic += payoutAtomic;
            score = SCORE_VALID;
        } else if (verdict == Verdict.Duplicate) {
            r.duplicate += 1;
            score = SCORE_DUPLICATE;
        } else if (verdict == Verdict.OutOfScope) {
            r.outOfScope += 1;
            score = SCORE_OUT_OF_SCOPE;
        } else {
            r.slop += 1;
            score = SCORE_SLOP;
        }
        bonded; // silence unused-read; refund/slash accounting lives in SubmissionRegistry

        emit Ruled(hunter, reportId, verdict, payoutAtomic);
        _publish(hunter, score, feedbackURI);
    }

    /**
     * Mirror the verdict into ERC-8004. Failures are emitted, never reverted:
     * a registry outage must not block triage, and a hunter's refund should
     * not depend on a third-party contract accepting a write.
     */
    function _publish(address hunter, int128 score, string calldata feedbackURI) private {
        if (address(reputationRegistry) == address(0)) {
            emit FeedbackSkipped(hunter, "no-registry");
            return;
        }
        uint256 agentId = agentIdOf[hunter];
        if (agentId == 0) {
            emit FeedbackSkipped(hunter, "no-agent-id");
            return;
        }
        try
            reputationRegistry.giveFeedback(
                agentId, score, SCORE_DECIMALS, TAG_DOMAIN, "bounty402", "", feedbackURI, bytes32(0)
            )
        {
            emit FeedbackPublished(hunter, agentId, score);
        } catch {
            emit FeedbackSkipped(hunter, "registry-reverted");
        }
    }

    // --- reads ------------------------------------------------------------

    function recordOf(address hunter) external view returns (Record memory) {
        return _records[hunter];
    }

    /// valid / triaged, in basis points. Returns 0 when nothing has been ruled.
    function signalRateBps(address hunter) external view returns (uint64) {
        Record storage r = _records[hunter];
        uint64 triaged = r.valid + r.duplicate + r.outOfScope + r.slop;
        if (triaged == 0) return 0;
        return uint64((uint256(r.valid) * 10_000) / triaged);
    }

    function hunterCount() external view returns (uint256) {
        return _hunters.length;
    }

    function hunterAt(uint256 i) external view returns (address) {
        return _hunters[i];
    }
}
