// Company-side settlement for a Solana-bonded report: verify the PoC, then
// refund the bond + pay the award to the hunter's Solana address via the Solana
// treasury (SPL USDC). The Solana analog of scripts/triager-flow.ts.
//
//   bun run demo/hunter/solana-settle.ts --id <reportId>
//
import { ready, db, getProgramRow, type ReportRow } from "../../lib/db";
import { solanaTreasuryFromEnv } from "../../lib/solana-treasury";
import { PUBLIC_URL } from "../../lib/config";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", process.env.BOUNTY402_URL ?? "http://127.0.0.1:3044")!;
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) { console.error("ADMIN_TOKEN not set"); process.exit(1); }

await ready;
const id = arg("id");
let r: ReportRow | null;
if (id) r = await db.query<ReportRow, [string]>("SELECT * FROM reports WHERE id = ?").get(id) ?? null;
else r = await db.query<ReportRow, []>(
  "SELECT * FROM reports WHERE network = 'solana-devnet' AND status = 'triaging' ORDER BY created_at DESC LIMIT 1").get() ?? null;
if (!r) { console.log("No Solana report in 'triaging'. Run the Solana hunt first."); process.exit(0); }
if (r.network !== "solana-devnet") { console.log(`report ${r.id} is on ${r.network}, not Solana`); process.exit(1); }

const prog = await getProgramRow(r.program);
const payouts = JSON.parse(prog?.payouts ?? "{}");
console.log(`settling ${r.id}  program=${r.program}  hunter(sol)=${r.payer}  status=${r.status}`);

const treasury = solanaTreasuryFromEnv();
const bal = await treasury.balances();
console.log(`treasury ${treasury.address}  SOL=${bal.sol}  USDC=${bal.usdc}`);
if (bal.sol <= 0) { console.error("Treasury has no SOL for gas — fund it with a little devnet SOL and re-run."); process.exit(1); }

// 1. verify (clones target, replays PoC — chain-agnostic)
console.log("\n── verify ──");
const vr = await fetch(`${BASE}/api/programs/${r.program}/reports/${r.id}/verify`, {
  method: "POST", headers: { Authorization: `Bearer ${ADMIN}` },
});
const v: any = await vr.json();
console.log(`verify: proven=${v.proven} severity=${v.severity} note=${(v.note ?? "").slice(0, 80)}`);
if (!v.proven) {
  await fetch(`${BASE}/api/admin/reports/${r.id}/verdict`, { method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "slop", note: "PoC not proven" }) });
  console.log("→ slop (PoC not proven). No payout.");
  process.exit(0);
}

// 2. settle on Solana: refund the bond + pay the award to the hunter
const bondTotal = (r.bond_usd ?? 0) + (r.poc_bond_usd ?? 0);
const award = Number(payouts[v.severity] ?? payouts.high ?? 8);
console.log(`\n── settle on Solana devnet ──  refund $${bondTotal} + award $${award} → ${r.payer}`);
if (bal.usdc < bondTotal + award) { console.error(`treasury USDC ${bal.usdc} < needed ${bondTotal + award}. Fund more USDC.`); process.exit(1); }

const refund = await treasury.pay(r.payer, bondTotal);
console.log(`refund: ${refund.signature}\n  ${refund.url}`);
const awardTx = await treasury.pay(r.payer, award);
console.log(`award:  ${awardTx.signature}\n  ${awardTx.url}`);

// 3. record the verdict (stores it on Swarm too)
const verdict = await fetch(`${BASE}/api/admin/reports/${r.id}/verdict`, {
  method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: JSON.stringify({ status: "valid", payoutUsd: award, refundTx: refund.signature, payoutTx: awardTx.signature,
    note: `Proven ${v.severity}; settled on Solana devnet.`, ruler: treasury.address }),
});
const vd: any = await verdict.json();
console.log(`\n✓ verdict: valid (${v.severity}) — refunded $${bondTotal} + awarded $${award} on Solana devnet.`);
if (vd.verdictSwarm) console.log(`  verdict on Swarm: ${vd.verdictSwarm.reference}`);
console.log(`  hunter USDC should now be +$${bondTotal + award}.`);
process.exit(0);
