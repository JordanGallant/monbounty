# monbounty local demo — web2 bounty (Acme Pay)

A self-contained, **local, secure** demo of the full monbounty loop: a company
(“Acme Pay”) runs a bug bounty, a hunter agent finds a real web vulnerability,
proves it, and gets paid — with nothing exposed to the internet.

## What's in the box

| Piece | Where | Notes |
|---|---|---|
| Vulnerable company API | `demo/target/server.ts` | “Acme Pay”, **binds 127.0.0.1 only**, planted IDOR |
| Bounty program | `acme-pay-demo` on monbounty | `company-attested` verify, pool funded |
| Verifier | `lib/verify.ts` | clones the target, replays the PoC, checks the assertion |

**The planted bug (IDOR / broken object-level auth):** `GET /api/accounts/:id`
returns any account with no ownership check. Account `1001` is an internal
service account whose record carries a live-looking key `sk_live_…LEAKED`. That
string is the committed proof the verifier asserts on.

## Security posture (why this is safe to run)

- **Loopback only.** The target refuses any non-loopback bind unless you set
  `ALLOW_PUBLIC=1`; `HOST=0.0.0.0` is force-reset to `127.0.0.1`. It is never
  reachable off the box.
- **Fake data.** The "secret" is `sk_live_…LEAKED` — not a real credential.
- **Secrets-free verifier.** The company's verifier runs the cloned target with a
  minimal env (PATH/HOME/LANG + PORT). Treasury keys, admin token and DB creds
  are never in that process's environment.
- **No public route.** The target is on `:4600`; no Caddy/site block points at
  it, so `monbounty.xyz` cannot reach it.

## Run it

**1. (one-time) register the bounty** — already done, but idempotent:

```bash
cd /opt/bounty402
bun run demo/setup-web2.ts
```

**2. start the vulnerable target** (leave it running):

```bash
PORT=4600 bun run demo/target/server.ts
# -> http://127.0.0.1:4600  (GET /api/me is yours; GET /api/accounts/1001 is the leak)
```

**3. read the program the hunter will work:**

```bash
curl -s http://127.0.0.1:3044/api/programs/acme-pay-demo/rules | jq
```

**4. run the hunter (a Claude session on this box).** Authorize it to spend a
small USDC bond, then let it work. A good opening prompt:

> You are a bug-bounty hunter agent. Target program: `acme-pay-demo` on monbounty
> at `http://127.0.0.1:3044`. The company's app is at `http://127.0.0.1:4600`.
> I authorize you to spend up to **$5 USDC (Monad testnet)** on bonds.
> 1. Read the program rules and scope.
> 2. Probe the app. Confirm `GET /api/me` is your own account, then look for a
>    way to read another account's data.
> 3. When you find it, submit a report and a PoC over x402 (impact `web-idor`,
>    request `GET /api/accounts/1001`).

**5. the company side verifies + pays.** The triager (already running as
`monbounty-triager.service`, or run `bun run scripts/triager-flow.ts`) clones the
target, replays the PoC, matches `sk_live_.*LEAKED`, grades it **high**, and
settles the award + bond refund — no human in the loop.

## Expected result

```
report -> bond paid (x402) -> verify: PROVEN high (sk_live_…LEAKED) -> settle: award + refund
```

The report, the evidence transcript, and the verdict are each stored on Swarm
(censorship-resistant), and the program's rules resolve at
`acme-pay-demo.monbounty.eth` via ENS contenthash.

## Reset

Stop the target (Ctrl-C). To remove the bounty, delete the `acme-pay-demo` row
(or leave it — re-running the setup is a no-op).
