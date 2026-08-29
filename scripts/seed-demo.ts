/**
 * Seeds fabricated history so the reputation tiers and leaderboard have
 * something to show. DEMO DATA ONLY — every row is tagged demo:true in
 * verdict_note and `--clear` removes exactly those rows and nothing else.
 *
 *   bun run scripts/seed-demo.ts          # insert
 *   bun run scripts/seed-demo.ts --clear  # remove
 */
import { db, ready } from "../lib/db";
import { reputationFor, touchHunter } from "../lib/reputation";
import { NET } from "../lib/config";

await ready;

const TAG = "demo:true";

if (process.argv.includes("--clear")) {
  const row = await db.query<{ n: number }, [string]>(
    "SELECT COUNT(*)::int AS n FROM reports WHERE verdict_note LIKE ?",
  ).get(`%${TAG}%`);
  await db.run("DELETE FROM reports WHERE verdict_note LIKE ?", [`%${TAG}%`]);
  await db.run("DELETE FROM hunters WHERE address NOT IN (SELECT DISTINCT payer FROM reports)");
  console.log(`removed ${row?.n ?? 0} demo report(s)`);
  process.exit(0);
}

const HUNTERS = {
  proven:    "0xa11ce00000000000000000000000000000000001",
  trusted:   "0xb0b0000000000000000000000000000000000002",
  penalised: "0x5107000000000000000000000000000000000003",
};

// [payer, program, title, severity, status, bond, pocBond, payout]
const ROWS: [string, string, string, string, string, number, number | null, number | null][] = [
  [HUNTERS.proven, "monad-escrow-demo", "Reentrancy in settle() drains committed bonds", "critical", "valid", 1, 4, 18000],
  [HUNTERS.proven, "monad-escrow-demo", "record() can over-commit unassigned balance", "high", "valid", 1, 4, 6500],
  [HUNTERS.proven, "x402-facilitator", "EIP-3009 nonce replay across resources", "critical", "valid", 2, 8, 24000],
  [HUNTERS.proven, "x402-facilitator", "Dynamic price read after settle", "medium", "duplicate", 2, 8, null],
  [HUNTERS.trusted, "monad-escrow-demo", "topUp() misses settled check on ruled rows", "medium", "valid", 1, 4, 2200],
  [HUNTERS.trusted, "x402-facilitator", "Facilitator timeout leaves report unqueued", "low", "out_of_scope", 2, 8, null],
  [HUNTERS.trusted, "monad-escrow-demo", "Owner can front-run rule() before settle", "medium", "valid", 1, 4, 1500],
  [HUNTERS.penalised, "x402-facilitator", "Critical RCE in the payment handler", "critical", "slop", 2, 8, null],
  [HUNTERS.penalised, "monad-escrow-demo", "Integer overflow in _committed", "high", "slop", 1, 4, null],
  [HUNTERS.penalised, "monad-escrow-demo", "Unbounded loop in submissionIds", "low", "out_of_scope", 1, 4, null],
];

const ins = db.prepare(
  `INSERT INTO reports (id, program, payer, title, severity, summary, asset, content_hash,
                        bond_usd, network, poc_bond_usd, status, verdict_note, triaged_at,
                        payout_usd, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,datetime('now'))`,
);

let day = 40;
for (const [payer, program, title, severity, status, bond, poc, payout] of ROWS) {
  await touchHunter(payer);
  await ins.run(
    crypto.randomUUID(), program, payer, title, severity,
    `Seeded demo history for reputation tiers. ${title}.`,
    "contracts/SubmissionRegistry.sol",
    "0x" + "de".repeat(32),
    bond, NET.id, poc, status, `${TAG} seeded ${day--} days ago`, payout,
  );
}

console.log(`inserted ${ROWS.length} demo reports\n`);
for (const [label, addr] of Object.entries(HUNTERS)) {
  const r = await reputationFor(addr);
  console.log(
    `${label.padEnd(10)} ${addr.slice(0, 10)}…  tier=${r.tier.padEnd(9)} ` +
    `bond×${r.bondMultiplier}  valid=${r.valid} slop=${r.slop} ` +
    `signal=${r.signalRate}%  paidOut=$${r.paidOutUsd}`,
  );
}
