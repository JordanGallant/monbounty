# bounty402 — the company side

The first cut priced the **hunter's** request: a bond makes spray-and-pray
submission expensive. This side answers the mirror question a company asks:

> *If an agent submits a real finding, how does it know it will actually get
> paid — the right amount, on time, without the company moving the goalposts?*

A contract cannot judge whether a vulnerability report is true. What it can do
is make the company's promise enforceable and its silence expensive. Half the
problem — smart-contract bugs — is also machine-checkable, and there we go
further: the payout condition is *executed*, not argued.

## What the contract guarantees the agent

Extended `SubmissionRegistry.sol` (10/10 tests green in `contracts/test/`):

| Hunter's old risk | Mechanism |
|---|---|
| "$10k program", company broke | **Escrowed pool.** `canAcceptSubmission()` / `poolRemaining()` are read before bonding — solvency is checkable, not promised. |
| Scope moved after reading the report | **`rulesHash` committed at `createBounty`.** Immutable; re-grading contradicts a published hash. |
| Verdict says critical, pays low | **`tiers[5]` on chain**, indexed by severity. `grade()` picks the impact; the number follows. Monotonicity enforced at creation. |
| Ghosted forever | **`claimTimeout()`** — after the committed SLA the hunter reclaims the bond unaided and earns `disclosable`. Platforms structurally can't offer this. |
| Valid finding, money still "processing" | **`settle()` pays award + refunds bond in one tx.** |
| Company reward money spent as bond collateral | **`_pooled` excluded from `unassigned()`** — proven by `test_PoolIsNotSpendableAsBondCollateral`. |

Verdicts are signed by the **bounty's own `ruler`** (the company's triager
agent), never the platform — bounty402 is not the judge of a dispute it earns a
fee on.

## Severity, made machine-checkable

`lib/severity.ts` — impact-based taxonomy (Immunefi VSCS, 12 categories, 9 with
an executable invariant), monotonic price validation, on-chain tier arrays,
per-TVL critical sizing. **Humans set the prices; the agent verifies the band.**

`contracts/poc/src/ImpactProof.sol` — the hunter writes only `exploit()`; every
assertion and balance measurement lives in code the company reads beforehand.
The band is observed, not claimed:

- theft (attacker up, protocol down) → **theft-user-funds / CRITICAL** — verified: `VALUE_MOVED 1000000000`
- withdrawal blocked now, later, forever → temporary / permanent freeze
- claims > assets → insolvency
- **moved nothing → rejected** (verified against a non-exploitable reentrancy and a no-impact rounding claim)

> Note: VaultBank's "reentrancy" is *not* exploitable — 0.8's underflow check
> reverts the over-withdrawal. The harness refused to grade it. That is the
> whole point: plausible ≠ payable.

## The demo: three agents, one flow

1. **company agent** — reads a target, drafts scope + rules + payout table,
   verifies severities, provisions a Circle wallet, funds it (Ramp fiat or
   USDC), calls `createBounty` + `fundBounty` with the committed `rulesHash`.
2. **hunter agent** — discovers it via `/api/programs`, checks the hash and the
   pool, bonds, submits, attaches the PoC.
3. **triager (company's ruler)** — runs the PoC through the harness, `grade()`s
   to the proven band; `settle()` pays award + bond atomically.

## Status

- [x] Escrow extended: pools, rulesHash, tiers, grade, claimTimeout, atomic settle — 10/10 tests
- [x] `lib/severity.ts` taxonomy + price validation
- [x] `ImpactProof` harness — theft proven CRITICAL, non-impact correctly rejected
- [x] Data layer moved to Supabase Postgres (see MIGRATION note below)
- [x] **Company onboarding agent** — `agent/company.ts` (Claude loop) + `agent/company-tools.ts` toolkit + `agent/company-toolspecs.ts`; verified end-to-end on live
- [x] Scripted no-key company flow — `scripts/company-flow.ts` (read→impacts→payouts→draft→wallet→create→fund→verify)
- [x] Company API: `POST /api/programs`, `GET /api/programs/:slug/rules` (hash verify), `POST /api/programs/:slug/fund`, `GET /api/severity`
- [x] `web/skills/company.md` — curl onboarding for a company agent, registered and live
- [x] `lib/rules.ts` — canonical rules + keccak256 rulesHash (stable under reorder)
- [ ] 3-agent end-to-end demo script (company → hunter → triager in one run)
- [ ] Deploy registry to Monad testnet, wire as `payTo` (needs MON in a deployer)
- [ ] Class A verifier wrapped as a runner (PROVEN/REJECTED, not forge pass/fail)
- [ ] Still blocked on funded wallets for a real paid run

## Data layer: Supabase

Moved off local SQLite to Supabase Postgres (2026-08-29). `lib/pg.ts` is an
async shim mimicking the bun:sqlite surface (`?`→`$n`, `datetime('now')`→
`now()::text`, `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`); `lib/db.ts` runs
schema+seed once via `ready`. Rollback: restore `lib/db.sqlite.ts.bak` over
`lib/db.ts`. Creds + `DATABASE_URL` (direct IPv6 endpoint) in `.env`.
