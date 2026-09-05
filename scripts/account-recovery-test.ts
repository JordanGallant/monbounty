/**
 * Proves the durable-identity story end-to-end against the live server:
 *   register → fund the account → "lose" the api key → recover with the recovery
 *   code → the NEW key sees the SAME balance → old key is dead → bound-address
 *   backstop blocks a withdrawal to any other address.
 *
 *   bun run scripts/account-recovery-test.ts
 */
const BASE = `http://localhost:${process.env.PORT ?? 3044}`;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
async function call(method: string, path: string, opts: { auth?: string; body?: any } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}

let fails = 0;
const check = (l: string, c: boolean, d = "") => { console.log(`${c ? "✓" : "✗"} ${l}${d ? "  " + d : ""}`); if (!c) fails++; };

// 1. register — first curl, get api key + recovery code
const reg = await call("POST", "/api/v1/accounts/register", { body: { kind: "hunter" } });
check("register returns account + both credentials", reg.status === 201 && !!reg.body.apiKey && !!reg.body.recoveryCode, reg.body.accountId ?? "");
const { accountId, apiKey: key1, recoveryCode } = reg.body;

// 2. fund the account (admin seeds $40 to its owner_ref — proven crediting path)
await call("POST", "/api/v1/accounts/register", { body: {} }); // noise account, ensures isolation
const ledger = await import("../lib/ledger");
await ledger.creditDeposit(`account:${accountId}`, ledger.toAtomic(40), "stripe", `test-seed-${Date.now()}`, "test funding");

// 3. the agent uses ITS api key to read balance
const bal1 = await call("GET", "/api/v1/accounts/me", { auth: key1 });
check("api key resolves to the account with $40", bal1.body.accountId === accountId && bal1.body.balanceUsd === 40, `$${bal1.body.balanceUsd}`);

// 4. "lose" key1 → recover with the recovery code → NEW key
const rec = await call("POST", "/api/v1/accounts/recover", { body: { recoveryCode } });
check("recover returns a fresh api key", rec.status === 200 && !!rec.body.apiKey && rec.body.accountId === accountId);
const key2 = rec.body.apiKey;

// 5. new key sees the SAME balance; old key is now dead
const bal2 = await call("GET", "/api/v1/accounts/me", { auth: key2 });
check("recovered key sees the SAME $40 balance", bal2.body.balanceUsd === 40, `$${bal2.body.balanceUsd}`);
const oldKey = await call("GET", "/api/v1/accounts/me", { auth: key1 });
check("the lost/old api key is revoked (401)", oldKey.status === 401);

// 6. bound-withdrawal backstop — binding requires the (rotated) recovery code,
//    NOT the api key, so a leaked key can't redirect funds.
const BOUND = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const newRecovery = rec.body.recoveryCode; // recover() rotated it
const bindNoRec = await call("POST", "/api/v1/accounts/bind-withdrawal", { auth: key2, body: { address: BOUND } });
check("bind with api key but NO recovery code is blocked (401)", bindNoRec.status === 401);
await call("POST", "/api/v1/accounts/bind-withdrawal", { body: { address: BOUND, recoveryCode: newRecovery } });
const wOther = await call("POST", "/api/v1/withdrawals", { auth: key2, body: { amountUsd: 5, toAddress: OTHER, network: "eip155:10143" } });
check("withdrawal to a NON-bound address is blocked (403)", wOther.status === 403, wOther.body.error ?? "");

console.log(`\naccount ${accountId}`);
console.log(fails === 0 ? "✓ durable identity + recovery + backstop proven" : `✗ ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
