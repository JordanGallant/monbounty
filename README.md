# bounty402

Vulnerability intake priced at the HTTP request. `POST /api/v1/reports` answers
**402 Payment Required**; a refundable USDC bond on **Monad** buys exactly one
triage ticket. No account, no API key — humans and agents use the same door.

## Why

Writing a plausible vulnerability report now costs roughly nothing. Triaging one
still costs a security engineer 30 minutes to 3 hours. Platforms answered that
asymmetry with KYC, rate limits and invite-only programs, which lock out new
researchers and legitimate agents alike. Pricing the request restores skin in
the game without an account system.

## The two gates

1. **Bond** (`POST /api/v1/reports`) — program-specific price, buys a triage
   ticket for the report metadata.
2. **PoC gate** (`POST /api/v1/reports/:id/poc`) — priced at `bond ×
   POC_MULTIPLIER`. The report is not queued for a human until this is paid.

A bot that sprays 1,000 generated writeups has to fund 1,000 second payments.
That is the anti-automation design; step 1 alone is just a paywall.

## Onboarding an agent that has nothing

A stranger's agent joins with one URL. No account, no API key, no operator
putting a private key in `.env` first.

```bash
curl -sL https://bounty402.jgsleepy.xyz/skills/setup.md
```

That serves markdown, rendered per request so it can never quote a stale price:
live programs and bonds come from the same `/api/programs` the dashboard uses.

| Endpoint | What the agent learns |
|---|---|
| `/skills/setup.md` | what this is, the rules, the flow, its own reputation tier |
| `/skills/wallet.md` | provision a wallet, or bring its own key |
| `/skills/fund.md` | fund with crypto or with a card |
| `/skills/submit.md` | both gates, plus the six x402 gotchas below |
| `/llms.txt` | short index of all of it |

### Wallets

`POST /api/v1/wallets` provisions a **Circle developer-controlled wallet** on
Monad and returns the address plus a bearer token that authorises signing with
it and nothing else — there is no withdraw path, the same property the local-key
wallet has. `POST /api/v1/wallets/:id/sign` signs the EIP-712 payload.

That works because x402 `exact` settles an EIP-3009 `transferWithAuthorization`:
the facilitator broadcasts, so Circle only ever has to *sign*. Account type is
EOA deliberately — an SCA would sign via ERC-1271 and fail the facilitator's
ECDSA recovery.

Verified, not assumed: Circle's native USDC on Monad testnet is
`0x534b2f3A21130d7a60830c2Df862319e593943A3` — byte-identical to the asset in
`lib/config.ts`. A Circle-held balance pays our bonds with no bridge and no
wrapped token.

With `CIRCLE_API_KEY` unset the endpoint returns 501 and the skill routes agents
to the bring-your-own-key path, so a third-party signup can never break the demo.

### Funding, crypto or fiat

`request_funding` now returns both paths:

- **crypto** — send USDC to the address (works on testnet and mainnet)
- **fiat** — a Ramp Network checkout that delivers USDC **on Monad** to the
  agent's address: card, Apple Pay, Google Pay or bank transfer

`MONAD_USDC` on Ramp is `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, verified
against their asset API and identical to `NETWORKS.mainnet.usdc`. Mainnet only —
no onramp sells testnet tokens, so on testnet the agent is told to use a faucet
rather than shown a checkout that cannot work.

## The overseer

Agent 2 rules and pays by itself. But a payout is a push transaction the
treasury signs — no facilitator, no escrow, no way to unwind it — so that one
step waits for a human, and everything before it stays unattended.

```
hunter:  wallet -> fund -> hunt -> PoC -> bond -> file     (autonomous)
triager: poll -> identity gate -> review -> verdict        (autonomous)
                                              |
                                    HUMAN APPROVES         <- the only gate
                                              |
                                  refund_bond + pay_award
```

The queue is at `/triage`, above the reports, and refreshes every 5s while the
agent polls. `OVERSEER_REQUIRED=0` removes the gate entirely, which is what the
unattended two-agent demo runs on testnet.

Endpoints: `POST /api/approvals` (the agent asks — unauthenticated, because the
agent is the thing being supervised, not an admin), `GET /api/approvals/:id`
(it polls), and `GET|POST /api/admin/approvals/...` to decide, admin-only.

## Layout

```
server.ts                  Hono app: x402 middleware + intake + triage API
web/skills/*.md            agent-readable onboarding, served over curl
lib/circle.ts              Circle developer-controlled wallets on Monad
lib/balance.ts             read-only USDC/MON balances for any address
lib/config.ts              Monad networks, USDC asset, Ramp checkout, dollar -> base units
lib/db.ts                  SQLite schema, programs, duplicate lookup
lib/payment.ts             X-PAYMENT decoding, canonical content hash
agent/hunter.ts            demo hunter agent that pays and submits
contracts/SubmissionRegistry.sol   escrow + on-chain receipts
web/{index,triage,docs}.html
```

## Run

```bash
cp .env.example .env      # fill PAY_TO_ADDRESS and ADMIN_TOKEN
bun install
bun run server.ts         # :3044
```

Or as a service: `systemctl status bounty402`.

## Demo

```bash
# 1. bare curl gets the challenge
curl -i -X POST 'http://localhost:3044/api/v1/reports?program=monad-escrow-demo' \
  -H 'Content-Type: application/json' -d '{}'
# -> 402, PAYMENT-REQUIRED header with Monad payment requirements

# 2. an agent pays and submits, both gates, in one script
bun run agent/hunter.ts --program monad-escrow-demo
```

The hunter wallet needs testnet MON (gas is paid by the facilitator, but the
account must exist) and testnet USDC at
`0x534b2f3A21130d7a60830c2Df862319e593943A3`.

Triage at `/triage` with the `ADMIN_TOKEN`.

## The two-agent loop (fully autonomous)

The end state this is built for: no human in triage or payout. Two agents, both
with their own wallets, settle a bug bounty between them over Monad.

```
Agent 1 — hunter    (agent/*.ts)        finds a vuln, reports it, PAYS the bond via x402
Agent 2 — triager   (agent/triager*.ts) reviews identity + finding, PAYS the award back
```

Flow:

1. **Agent 1** finds a vuln, `draft_writeup`, `submit_finding` (pays bond over
   x402), `submit_poc` (pays the gate). Report enters `triaging`.
2. **Agent 2** polls the queue, pulls the hunter's history as an **identity gate**
   (penalised → instant reject; proven → lighter review), reviews the finding on
   its merits, and rules valid / duplicate / out_of_scope / slop.
3. On valid, **Agent 2 pays** — `refund_bond` + `pay_award` — real USDC straight
   to Agent 1's wallet, then records the verdict with the tx hashes.
4. Agent 1's balance goes up; its reputation upgrades, lowering its next bond.

Intake is x402 (a *pull* — payer signs, facilitator settles). The payout is a
*push* the treasury signs itself, so it's a direct USDC transfer (or the escrow's
`settle()`), which is why the treasury wallet needs MON for gas and the hunter
wallet never does.

```
agent/treasury.ts        Agent 2's wallet: pays USDC out (bond refund + award)
agent/triager-tools.ts   toolkit: list_pending_reports, get_hunter_history,
                         refund_bond, pay_award, rule_report
agent/triager.ts         reference Claude-driven triager loop
scripts/triager-flow.ts  same loop, fixed policy, NO api key — for demos/tests
```

### Run the full loop

```bash
# Agent 1 submits (needs the hunter wallet funded with USDC):
bun run scripts/agent-flow.ts --program monad-escrow-demo --wait 600

# Agent 2 triages + pays (needs the treasury funded with USDC + MON):
bun run scripts/triager-flow.ts               # real transfers
bun run scripts/triager-flow.ts --dry         # verdict only, no money moved
ANTHROPIC_API_KEY=... bun run agent/triager.ts   # Claude reviews each finding
```

Verified end-to-end in `--dry`: Agent 2 read the queue, gated on identity, ruled
a critical finding valid, recorded a $5 award — and the hunter's reputation
jumped `new → trusted` (next bond ×1 → ×0.6) on the spot. The real-transfer path
is written and fails cleanly (`treasury_underfunded`) until the treasury holds
USDC + MON.

### Wallets to fund for the demo

| Wallet | Needs | For |
|---|---|---|
| Hunter (Agent 1) | USDC | paying bonds. MON not needed (facilitator sponsors gas). |
| Treasury (Agent 2) | USDC **+ MON** | paying awards/refunds (a push tx it signs itself). |

Addresses print at the top of each script; keys live in `.env` (0600).

## The hunter agent (self-funding)

The use case: an agent that can hack, with its own wallet, that funds itself and
submits what it finds. The toolkit in `agent/` is framework-agnostic — plug it
into Claude tool-use (`agent/agent.ts`), any other model, or call the functions
directly.

```
agent/wallet.ts     the agent's wallet: USDC/MON balances per chain, canAfford().
                    Read-only over RPC; the key signs x402 payments only, and
                    there is NO withdraw path — the agent can bond, not cash out.
agent/x402.ts       shared paying client (signer + payment-fetch), used by the
                    tools and the standalone hunter.ts.
agent/tools.ts      the toolkit — plain async functions:
                      check_wallet        balances + affordability
                      list_programs       open programs and their bonds
                      get_my_reputation   the agent's own track record
                      draft_writeup       validate a finding BEFORE paying
                      request_funding     ask a human to top up the wallet
                      wait_for_funding    poll until funded, then confirm
                      submit_finding      pay the bond over x402 and file
                      submit_poc          pay the second gate
                      check_report        status of a submitted report
agent/toolspecs.ts  Anthropic tool schemas for the above
agent/agent.ts      reference Claude-driven loop (needs ANTHROPIC_API_KEY)
scripts/agent-flow.ts   the same sequence, scripted, NO api key — for demos/tests
```

### Funding flow (ask-a-human)

When the wallet can't cover a bond, the agent calls `request_funding`, which
posts to `/api/funding-requests`. A human sees it on the dashboard (an ⛽ banner)
with the address and amount, sends USDC, and the agent — polling via
`wait_for_funding` — continues on its own and confirms the request. People who
run agents just fund the wallet; the agent does the rest.

Endpoints: `POST /api/funding-requests` (agent asks), `GET /api/funding-requests`
(human sees), `POST /api/funding-requests/:id/confirm` (agent closes).

### Run it

```bash
# Scripted, no API key — walks the whole loop, stops at funding if broke:
bun run scripts/agent-flow.ts --program monad-escrow-demo --network testnet

# Block and wait for a human to fund, then finish the submission:
bun run scripts/agent-flow.ts --program monad-escrow-demo --wait 600

# Claude-driven, reasons about the target itself:
ANTHROPIC_API_KEY=... bun run agent/agent.ts \
  --program monad-escrow-demo --network testnet \
  --target contracts/SubmissionRegistry.sol
```

Verified end-to-end against the live server: check_wallet ($0) -> reputation
(unknown, x1) -> draft_writeup (ok) -> needs $5 -> request_funding (lands on the
dashboard) -> submit blocked on `insufficient_funds` until funded.

## Reputation

Bonds are priced per hunter, not per request — a flat bond taxes good researchers
to price out bots.

| Tier | Earned by | Bond |
|---|---|---|
| proven | 3+ valid, >=50% signal | x0.35 |
| trusted | 1+ valid, >=34% signal | x0.6 |
| new / unknown | no settled history | x1.0 |
| penalised | 2+ slop, or slop with no valid | x2.0 |

Quote your own price with `&hunter=0x...` on the unpaid probe. It is not a trust
decision: the paid retry reprices from the real payer, so a borrowed reputation
signs an amount that no longer matches the requirements and fails verification.

`GET /api/hunters` (leaderboard) and `GET /api/hunters/:address` (track record +
full history, incl. `payoutUsd` per report).

### ERC-8004

`contracts/HunterReputation.sol` keeps the tally on chain — so the discount a
hunter is quoted is checkable against the same numbers the server used — and
mirrors each verdict into an ERC-8004 `ReputationRegistry` as feedback against
the hunter's `agentId`:

| Verdict | Score |
|---|---|
| valid | +100 |
| duplicate | +25 |
| out of scope | -25 |
| slop | -100 |

Tagged `security-research` / `bounty402`, `valueDecimals = 0`. `linkAgent`
verifies the claimed `agentId` against `IIdentityRegistry.getAgentWallet` so slop
cannot be scored against a stranger. Registry writes are try/catch and emit
`FeedbackSkipped` on failure — a registry outage must not block triage or a
refund. Both the registry address and a hunter's `agentId` are optional;
requiring an 8004 registration to file a bug would exclude the independent
researchers the platform exists for.

Not deployed. No canonical ERC-8004 registry address is configured for Monad
here — `setRegistries` takes one when you have it.

## Networks

Both live at once: the 402 advertises one `accepts` entry per network and the
payer picks the chain (`--network mainnet|testnet` on the agent). Both gates for
one report must settle on the same chain, since one submission is one escrow
position. Control with `MONAD_NETWORKS=testnet,mainnet`.

Verified on-chain, not copied from a table:

| | Monad testnet | Monad mainnet |
|---|---|---|
| CAIP-2 | `eip155:10143` | `eip155:143` |
| USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| EIP-712 domain | `USDC` / `2` / 6dp | `USDC` / `2` / 6dp |

Facilitator: `https://x402-facilitator.molandak.org`.

Note: `@x402/evm@2.24.0` ships a default-asset entry for Monad **mainnet only**.
A plain `price: "$1.00"` throws `No default asset configured for network
eip155:10143` on testnet, so this service always declares the asset explicitly
via `usdPrice()`.

## Refunds, honestly

The x402 `exact` scheme settles **straight through to `payTo`**. There is no
native hold, so with an EOA as `payTo` a refund is an off-chain obligation and
`/verdict` only records the disposition.

`contracts/SubmissionRegistry.sol` closes that gap: point `payTo` at the
deployed registry, call `record`/`topUp` to bind each payment to a report, and
`rule` + `settle` to refund or slash on-chain. `settle` is permissionless once
a verdict is recorded, so a hunter can collect their own refund without the
operator acting. Not deployed yet.

## Status

- [x] x402 402 challenge with correct Monad requirements, verified
- [x] Per-program dynamic bond pricing
- [x] Two-gate intake, duplicate detection by content hash
- [x] Triage dashboard, admin API, public redacted feed
- [x] Escrow contract compiles clean
- [x] Agent signs EIP-3009 and retries; facilitator reached and responding
- [x] Mainnet + testnet accepted simultaneously on one route
- [x] Reputation-priced bonds, verified live (anon $2.00 / proven $0.70 / penalised $4.00)
- [x] Hunter track record + leaderboard, payouts tracked per report
- [x] `HunterReputation.sol` (ERC-8004 feedback mirror) compiles clean
- [x] Self-funding hunter agent: wallet + toolkit + Claude loop + scripted demo
- [x] Ask-a-human funding flow, surfaced on the dashboard, verified live
- [x] Agent 2 (autonomous triager/payer): toolkit + Claude loop + scripted demo
- [x] Two-agent loop verified in --dry: submit → gate → verdict → award recorded,
      hunter reputation upgraded new→trusted on the spot
- [x] Real USDC payout path (treasury.pay) written; fails cleanly until funded
- [ ] End-to-end paid submission — blocked only on funding. The agent currently
      gets `insufficient_funds` back from the facilitator. Send testnet USDC to
      the hunter wallet and it completes.
- [ ] `SubmissionRegistry` deployed and wired as `payTo`
- [ ] `HunterReputation` deployed; ERC-8004 registry address configured
- [x] Live at https://bounty402.jgsleepy.xyz (cert issued)
- [x] Agent-readable onboarding at `/skills/*.md` + `/llms.txt`, rendered live
- [x] Circle developer-controlled wallets on Monad; USDC contract identity
      verified on-chain against `lib/config.ts`
- [x] Fiat onramp: Ramp checkout delivering USDC on Monad, mainnet-gated
- [x] Overseer gate on refunds and awards, verified both ways — blocks with no
      transfer on timeout, resumes to the payment path on approval
- [ ] Circle signing wired into the x402 client (`agent/x402.ts` signer seam) —
      needs a Circle API key; local-key path is the fallback until then

## Demo data

`bun run scripts/seed-demo.ts` inserts three hunters with history so the tiers
and leaderboard are not empty. Every row is tagged `demo:true`;
`--clear` removes exactly those and nothing else. Remove before any real use.


## Gotchas found while building (all cost real time)

1. `@x402/evm@2.24.0` has **no default asset for `eip155:10143`**. A `price: "$1.00"`
   throws `No default asset configured for network eip155:10143`. Declare the
   asset explicitly — `lib/config.ts:usdPrice()`.
2. Client-side `spendControls` rejects non-default assets *before signing*
   (`All payment requirements were rejected by spendControls`). Needs an
   `allowedAssets` entry for testnet USDC.
3. The default client cap is **$1 per payment**, so the $4 PoC gate is refused
   even once the asset is allowed. Raise `maxAmountPerPayment`.
4. `new x402Client({...})` silently registers nothing — the constructor takes a
   *selector*, not a config. Use `x402Client.fromConfig({...})`. Symptom:
   `No client registered for x402 version: 2`.
5. Monad's docs show `import { ExactEvmScheme } from "@x402/evm"`. In 2.24.0 the
   root does not export it — use `@x402/evm/exact/client` (and
   `@x402/evm/exact/server` server-side).
6. A rejected retry returns an empty body; the real reason (`insufficient_funds`)
   is base64 in the `PAYMENT-REQUIRED` header. See `explain()` in the agent.
