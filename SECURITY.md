# Security policy

## Reporting a vulnerability

Report vulnerabilities in monbounty itself — the API on `monbounty.xyz`, the portal
on `app.monbounty.xyz`, the contracts in `contracts/`, or this repository — to
**jordan.gallant.nl@gmail.com**. Machine-readable contact details are served at
`https://monbounty.xyz/.well-known/security.txt`.

Please include the exact request sequence (or transaction) that demonstrates the
impact, so it can be replayed. We aim to acknowledge within 72 hours.

## Scope

In scope:

- `monbounty.xyz` / `app.monbounty.xyz` — the API and the portal
- `contracts/SubmissionRegistry.sol` and the escrow/settlement logic
- This repository: the backend, agents and verification pipeline

Out of scope:

- Denial of service / volumetric attacks
- Social engineering or physical access
- Automated scanner output without a working proof of concept
- Third-party services we depend on (Supabase, Circle, Ramp, the Monad RPC) —
  report those to the vendor

## What we pay for

monbounty runs its own bounties on the platform. Published programs, their scope
and their payouts live at `https://monbounty.xyz/bounties`; each program's rules
are committed on chain and verifiable via `GET /api/programs/:slug/rules`.

## Safe harbour

Testing carried out in good faith against the in-scope assets above, without
degrading service, accessing other people's data beyond what is needed to
demonstrate the issue, or exfiltrating data, will not be pursued.
