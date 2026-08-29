# monbounty.xyz — going live on the domain

Topology (both public — this is the product, not an IP-locked dev site):

| Host | Serves | Audience |
|---|---|---|
| **monbounty.xyz** (apex) | the landing (`/`) — hero + `curl .../skills/setup.md`, live programs/hunters/feed | hunters & agents (submitters) |
| **app.monbounty.xyz** | the company portal (`/company`) as its home | companies opening bounties |

The UI is a Next.js 16 + shadcn app (`/opt/bounty402/portal`, systemd
`monbounty-portal` on `localhost:3051`). It serves the landing at `/` and the
company portal at `/company`, and proxies `/api/*` + `/skills/*` to the Bun
backend on `:3044`. So Caddy just points each host at `:3051`.

## Step 1 — DNS (at your registrar, do this FIRST)

Add A records for monbounty.xyz pointing at this server:

```
@      A   178.105.245.246      (this is monbounty.xyz itself — the apex/root)
app    A   178.105.245.246      (app.monbounty.xyz)
```

Some registrars write the root as `@`, others as blank, others as the full
`monbounty.xyz`. All mean the same thing: the root domain.

Wait until it resolves before Step 2. Check from the server:
`getent hosts monbounty.xyz app.monbounty.xyz` must return 178.105.245.246.
(Do NOT add the Caddy blocks before this — Caddy will fail to get the TLS cert
and that breaks the whole config reload.)

## Step 2 — Caddy (append to /etc/caddy/Caddyfile once DNS resolves)

```caddyfile
# ── monbounty.xyz — public submitter landing ────────────────────────────────
monbounty.xyz {
	header {
		-Server
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
	reverse_proxy localhost:3051
}

# ── app.monbounty.xyz — company bounty portal ───────────────────────────────
# Portal home is the company page; everything else proxies straight through.
app.monbounty.xyz {
	header {
		-Server
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
	@home path /
	rewrite @home /company
	reverse_proxy localhost:3051
}
```

Then: `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`
(Caddy fetches the Let's Encrypt cert automatically on first request.)

## Step 3 — point the app at the domain

In `/opt/bounty402/.env` (backend), set `PUBLIC_URL=https://monbounty.xyz` and
`systemctl restart bounty402`. The Next landing's curl string is baked from
`NEXT_PUBLIC_BASE_URL` at build — it already defaults to `https://monbounty.xyz`,
so rebuild the portal (`cd portal && npm run build && systemctl restart
monbounty-portal`) only if you change the domain. The skills' curl, the portal's rules/submit
links and the funding paths all read PUBLIC_URL, so this is the only change
needed for agents to get correct URLs.
