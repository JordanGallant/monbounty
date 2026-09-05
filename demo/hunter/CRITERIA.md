# Hunter agent — bounty selection criteria

The hunter does not pick a bounty by gut. It scores every open program against
four weighted factors and works the highest-scoring one that clears the gates.
The whole point is **time feasibility**: pick a bounty it can actually *prove*
inside the SLA and the demo window, that pays more than it costs to try.

`demo/hunter/select.ts` computes this live from the monbounty API.

## Hard gates (fail any → skip the bounty)

1. **Liquidity** — the hunter holds enough USDC on at least one chain the bounty
   accepts to pay both x402 gates (submit bond + PoC bond). No funds on an
   accepted chain → cannot even bond → skip.
2. **Solvent pool** — the program's reward pool is funded ≥ committed. An
   unfunded pool can't pay an award → skip.
3. **Verifiable** — the program has a verification path (`company-attested`
   web target, or `onchain-fork`). No way to prove impact → skip (nothing to
   settle on).

## Weighted score (0–100)

| Factor | Weight | What it measures |
|---|---:|---|
| **Feasibility** | 40 | Can I actually prove an impact here? |
| **Time** | 20 | Can I prove it inside the SLA and the demo? |
| **Economics** | 25 | Is the expected payout worth the bonds at risk? |
| **Liquidity fit** | 15 | Do I already hold funds on an accepted chain? |

### Feasibility (0–40)
- +20 × (share of the program's accepted impacts that are **machine-checkable** —
  an executable invariant or a committed assertion the verifier checks, not a
  prose argument).
- +12 if the program is **verifiable end-to-end** (`company-attested` with a
  target the verifier can clone+run, or `onchain-fork`).
- +8 if the **scope is concrete** (named endpoints/contract, not "the whole app").

### Time (0–20)
- SLA headroom: +12 scaled by `min(slaSeconds / estHuntSeconds, 1)` — more time
  than the estimated hunt needs is safer.
- Fast to verify: +8 if the verifier boots quickly (web target `bootSec ≤ 25`, or
  a Foundry PoC which runs in milliseconds). Slow/managed deploys lose these.

### Economics (0–25)
- Expected value `EV = confidence × maxReward − (submitBond + pocBond)`.
- Score = 25 × normalised EV across the open set (higher reward-to-bond wins).
- `confidence` comes from feasibility: a machine-checkable, concrete-scope bug
  the agent can see is high-confidence; a vague web2 category is lower.

### Liquidity fit (0–15)
- +15 if the hunter is funded on the bounty's **preferred/cheapest** accepted
  chain; +8 if funded on any accepted chain but not the cheapest; 0 otherwise
  (but note: 0 here with the liquidity gate already passed can't happen).

## Trust gate & auditability (Swarm + ENS)

Before bonding, the agent confirms the bounty's rules are **provably immutable**:
the verifier checks `on-chain rulesHash == keccak256(Swarm bytes) == ENS
contenthash` (`GET /api/programs/<slug>/proof`). A company that could quietly
rewrite scope or payouts after you bond is not worth working — so a bounty whose
three-way proof doesn't hold is treated as untrusted.

Each program's rules already live on Swarm and resolve at `<slug>.monbounty.eth`.
And the agent's **own decision is published to Swarm** — the full ranking, the
gates, and the pick — so the reasoning behind every bond is a censorship-resistant,
auditable artifact, not a black box.

Liquidity is checked on **both chains** (Monad USDC + Solana devnet USDC); the
agent prefers to bond on Solana devnet (the cheaper, in-process x402 rail).

## Decision

- Rank by total score, descending.
- Work the top program whose **estimated proof time < SLA** and < the demo window.
- If two are within 5 points, prefer the one with the **shorter proof time** (a
  cleaner, faster PROVEN result reads better in a demo).
- Re-evaluate after each submission (reputation changes bond multipliers, which
  changes economics).
