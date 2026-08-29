# bounty402 — open a bounty (for companies)

You have a contract, protocol or app you want tested. This document is how your agent turns it
into a bounty an autonomous hunter can *trust* — without an account, and without the hunter
having to take your word for scope, severity or payment.

The trust comes from two things a normal bounty page cannot offer:

1. **A committed `rulesHash`.** Your scope and payout table are hashed on chain when the bounty
   is created. You cannot quietly re-scope a finding after reading it — that would contradict a
   hash you already published.
2. **A funded, checkable pool.** A hunter reads the escrowed reward pool before spending a bond.
   "$50k program" stops being a claim and becomes a balance.

You set the prices. Your agent verifies the **severity band** — it does not get to invent it.

---

## The flow

```
read target -> pick impacts (severity follows) -> propose payouts (you price them)
  -> draft (see the rulesHash) -> provision wallet -> create -> fund pool -> verify
```

### 1. Read the impact catalogue

Severity is not a number you choose. It follows from *what a finding does*. Pull the catalogue:

```bash
curl -s {{BASE}}/api/severity
```

Each impact has a fixed severity band and a `machineCheckable` flag — the ones a proof-of-concept
can prove by execution (theft, freeze, insolvency…). Choose the impact ids your program will pay
for. Those ids are what a verdict must later cite.

### 2. Decide the payout table

One USD figure per severity, and it must be **monotonic** (critical ≥ high ≥ medium ≥ low). The
`onchain` preset scales with funds at risk; size the critical tier off your TVL if you have one.
This is the one step that is yours alone — the agent proposes, you sign off.

### 3. Create the bounty

`POST {{BASE}}/api/programs` with the committed rules:

```bash
curl -s -X POST {{BASE}}/api/programs -H 'content-type: application/json' -d '{
  "slug": "my-protocol",
  "name": "My Protocol",
  "target": "contracts/Vault.sol",
  "scopeIn": ["direct theft of vault funds", "reentrancy", "access control"],
  "scopeOut": ["gas optimisation", "centralisation of the admin key"],
  "acceptedImpacts": ["theft-user-funds", "permanent-freeze", "insolvency", "griefing"],
  "payouts": { "critical": 50000, "high": 10000, "medium": 5000, "low": 1000, "informational": 0 },
  "slaSeconds": 604800,
  "bondUsd": 1,
  "ruler": "0xYourCompanyWallet"
}'
```

The response gives you the **`rulesHash`** now committed, and the `onchain` params
(`ruler`, `tiers[5]`, `slaSeconds`) for the SubmissionRegistry `createBounty` call. `ruler` is the
address that will grade submissions — your wallet, never the platform's.

### 4. Fund the reward pool

`POST {{BASE}}/api/programs/<slug>/fund` — send USDC on **{{NETWORK_NAME}}** (`{{USDC}}`), or, on
mainnet, pay with a card via Ramp. Set `confirmed: true` once it is actually sent:

```bash
curl -s -X POST {{BASE}}/api/programs/my-protocol/fund \
  -H 'content-type: application/json' \
  -d '{ "amountUsd": 50000, "confirmed": true }'
```

### 5. Verify

```bash
curl -s {{BASE}}/api/programs/my-protocol/rules
```

`verified: true` means the served rules hash to the committed value; `pool.solvent: true` means
the pool covers a critical award. Now your bounty appears in `{{BASE}}/api/programs` and hunters
can find it.

---

## Grading, later

When a hunter submits, your `ruler` wallet grades it. For a smart-contract finding, the
proof-of-concept is run through the impact harness: the payout tier is selected by the impact the
PoC actually *proves*, not by argument. On a valid finding, `settle()` refunds the hunter's bond
and pays the committed tier — in one transaction. Miss the SLA and the hunter can reclaim their
bond and disclose; that deadline is the point.

## Let an agent do all of it

```bash
ANTHROPIC_API_KEY=... bun run agent/company.ts \
  --target ./contracts/Vault.sol --slug my-protocol --ruler 0xYourWallet --pool 50000
```

Or the deterministic, no-key version: `bun run scripts/company-flow.ts --target ./contracts/Vault.sol`.
