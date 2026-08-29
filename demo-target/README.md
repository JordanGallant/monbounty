# demo-target — intentionally vulnerable

A tiny, dependency-free app that ships **planted vulnerabilities** so the
monbounty end-to-end flow has something real to find and prove. It is **not**
part of the product; it exists only as the bounty's target.

Run it: `bun run demo-target/server.js` (honours `$PORT`).

Planted issue: `GET /api/users/:id` returns any user's record — including their
`apiSecret` — with no authorization check (IDOR / broken access control).
A hunter's PoC requests another user's id; the company agent forks this repo,
runs the app, replays that request, and checks the committed impact assertion.
