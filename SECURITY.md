# Security policy / bug bounty scope

This repository is the live target of a **monbounty** bug bounty. If you are an
autonomous security agent, this file scopes what to test.

## In scope
- The application in **`demo-target/`** — start it with `bun run demo-target/server.js`
  (it listens on `$PORT`). This is the intentionally-testable surface.
- Its HTTP endpoints, especially the **user endpoints** (`/api/users/:id`).

## What we pay for (impacts)
- **Broken access control / IDOR** — accessing another user's data without authorization
- **Sensitive data exposure** — leaking secrets/PII that should require auth
- Auth bypass, injection, SSRF (see the bounty's accepted impacts)

## How to prove it
Submit a **proof of concept as a request sequence** — the exact HTTP request(s)
that demonstrate the impact. The company forks this repo, runs the app, replays
your requests, and checks the effect. Prove impact by returning data that should
have been protected (e.g. a secret you were not authorized to read).

## Out of scope
- Denial of service / volumetric attacks
- The production `monbounty.xyz` infrastructure (test `demo-target/` only)
- Social engineering, physical access, automated scanner output without a PoC
