// End-to-end test of the web2 bounty (acme-pay-demo), the way the product really
// works — a Circle-custodied AI hunter, paid over x402, verified against the real
// code, and settled autonomously by the company's triager. No local private key.
//
//   cd /opt/bounty402 && bun run demo/test-web2.ts
//
// It prints each stage, then the on-chain settlement. Watch it land on the
// company dashboard at https://demo.monbounty.xyz while this runs.

import { createWallet } from "../lib/circle";
import { treasuryFromEnv } from "../agent/treasury";
import { makeCircleEvmClient } from "../agent/x402";
import { balanceOn } from "../lib/balance";
import { NET } from "../lib/config";

const BASE = process.env.BOUNTY402_URL ?? "http://127.0.0.1:3044";
const PROGRAM = "acme-pay-demo";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = () => console.log("─".repeat(64));

console.log("\n  monbounty · web2 bounty end-to-end test");
line();

// 1 ─ provision a Circle wallet (HSM-held, no local key)
console.log("① Provisioning a Circle wallet for the hunter (key stays in Circle)…");
const w = await createWallet(NET);
console.log(`   ${w.address}   (Circle-held, agent never sees a key)`);

// 2 ─ fund it
console.log("\n② Funding the wallet with $6 USDC…");
const treasury = treasuryFromEnv();
await treasury.pay(w.address, 6, "testnet");
let usdc = 0;
for (let i = 0; i < 20; i++) { usdc = (await balanceOn(w.address, NET)).usdc; if (usdc > 0) break; await sleep(3000); }
console.log(`   funded: ${usdc} USDC`);

// 3 ─ hunt: submit the finding + PoC, both paid over x402, signed by Circle
console.log(`\n③ Hunting ${PROGRAM} — reading scope, filing the IDOR, paying both x402 gates…`);
const client = makeCircleEvmClient(w.walletId, w.address, { network: "testnet" });
const finding = {
  program: PROGRAM,
  title: "IDOR: /api/accounts/:id returns another account's data (incl. service API key)",
  severity: "high",
  asset: "/api/accounts/:id",
  summary: `The accounts endpoint returns any account by id with no ownership check; requesting /api/accounts/1001 while logged in as another account leaks the internal service account's live API key — broken object-level authorization. (ref ${Date.now().toString(36)})`,
};
const r1 = await client.fetch(`${BASE}/api/v1/reports?program=${PROGRAM}&hunter=${w.address}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(finding),
});
const j1: any = await r1.json();
if (!j1.id) { console.error("   submit failed:", JSON.stringify(j1).slice(0, 160)); process.exit(1); }
console.log(`   report ${j1.id.slice(0, 8)} · bond paid`);
const poc = JSON.stringify({ impact: "web-idor", requests: [{ method: "GET", path: "/api/accounts/1001" }] });
const r2 = await client.fetch(`${BASE}/api/v1/reports/${j1.id}/poc?hunter=${w.address}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poc }),
});
const j2: any = await r2.json();
console.log(`   PoC paid · status: ${j2.status} · stored (encrypted) on Swarm`);

// 4 ─ wait for the company's autonomous triager to verify + settle
console.log("\n④ Company triager verifying against the real code + settling (autonomous)…");
let done: any = null;
for (let i = 0; i < 20; i++) {
  const feed: any = await (await fetch(`${BASE}/api/programs/${PROGRAM}/reports`)).json();
  const rep = feed.reports.find((r: any) => r.id === j1.id);
  if (rep?.status === "valid") { done = rep; break; }
  if (rep?.status === "slop") { console.log("   ✗ slop — PoC not proven"); process.exit(1); }
  process.stdout.write(".");
  await sleep(4000);
}
console.log();

// 5 ─ result
line();
if (done) {
  console.log(`\n✓ PROVEN ${done.severity.toUpperCase()} AND PAID — no human in the loop\n`);
  console.log(`   bond refunded  $${done.bondUsd}`);
  console.log(`   award paid     $${done.payoutUsd}`);
  for (const t of done.trace.filter((x: any) => x.url)) console.log(`   ${t.text.replace(/\s+/g, " ").trim()}  →  ${t.url}`);
  const post = await balanceOn(w.address, NET);
  console.log(`\n   hunter wallet: ${usdc} → ${post.usdc} USDC  (net +$${(post.usdc - usdc).toFixed(2)})`);
  console.log(`\n   Company view of this: https://demo.monbounty.xyz`);
} else {
  console.log("\n⚠ Timed out waiting for the triager. Is monbounty-triager.service running?");
}
console.log();
process.exit(0);
