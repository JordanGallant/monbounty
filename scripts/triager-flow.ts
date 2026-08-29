/**
 * Scripted Agent 2 — the triager/payer run with a fixed policy, no LLM, no API
 * key. Demonstrates the end-to-end autonomous loop deterministically:
 *
 *   list queue -> for each: identity gate -> verdict -> refund + award -> record
 *
 *   bun run scripts/triager-flow.ts --network testnet
 *
 * Policy (what Claude decides in agent/triager.ts, hard-coded here):
 *   - penalised hunter        -> slop, no payout
 *   - otherwise               -> valid; refund bond + pay a severity-scaled award
 * Awards below are demo-sized so a lightly-funded treasury can actually pay them.
 */
import { treasuryFromEnv } from "../agent/treasury";
import * as TT from "../agent/triager-tools";
import type { TriagerContext } from "../agent/triager-tools";
import { PUBLIC_URL } from "../lib/config";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;
const dry = process.argv.includes("--dry"); // rule but skip real transfers

if (!process.env.ADMIN_TOKEN) { console.error("ADMIN_TOKEN not set."); process.exit(1); }

const ctx: TriagerContext = { treasury: treasuryFromEnv(), baseUrl, adminToken: process.env.ADMIN_TOKEN };

// Demo award schedule (USDC). Real programs would pay the posted reward range.
const AWARD: Record<string, number> = { critical: 5, high: 3, medium: 1.5, low: 0.5, informational: 0.1 };

const show = (x: any) => console.log("   " + JSON.stringify(x));
console.log(`triager (scripted)  treasury=${ctx.treasury.address}`);
console.log(`treasury balance:`, JSON.stringify(await ctx.treasury.balance("testnet")), "\n");

const { reports } = await TT.list_pending_reports(ctx);
if (!reports.length) { console.log("Queue empty — nothing to triage. (Submit something with the hunter first.)"); process.exit(0); }
console.log(`${reports.length} report(s) in the queue\n`);

const programs = (await fetch(`${baseUrl}/api/programs`).then((x) => x.json())).programs;
const modeOf = (slug: string) => programs.find((p: any) => p.slug === slug)?.verificationMode ?? "onchain-fork";
// The award is the program's OWN committed payout for the PROVEN severity — the
// same number the scope advertises — not a hardcoded demo constant.
const payoutsOf = (slug: string) => programs.find((p: any) => p.slug === slug)?.payouts ?? {};

for (const r of reports) {
  console.log(`── ${r.id.slice(0, 8)} · ${r.severity} · ${r.title}`);
  const full = await TT.get_report(ctx, { id: r.id });
  const program = full.program ?? r.program;
  const hist = await TT.get_hunter_history(ctx, { address: r.hunter });
  console.log(`   hunter ${r.hunter.slice(0, 12)}… tier=${hist.tier} valid=${hist.valid} slop=${hist.slop}`);

  // identity gate
  if (hist.tier === "penalised") {
    console.log("   GATE: penalised hunter → slop, no payout");
    show(await TT.rule_report(ctx, { id: r.id, status: "slop", note: "Auto-rejected: hunter has a history of slop." }));
    continue;
  }

  // verification gate — company-attested bounties are proven by executing the PoC.
  // The PROVEN severity (from running the PoC) sets the payout, not the claim.
  const mode = modeOf(program);
  let severity = r.severity;
  if (mode === "company-attested") {
    let poc: any = undefined;
    try { poc = JSON.parse(full.poc ?? ""); } catch {}
    const v = await TT.verify_submission(ctx, { program, id: r.id, poc });
    console.log(`   verify: ${v.proven ? "PROVEN " + v.severity : "NOT proven"}  evidence ${(v.evidenceHash || "").slice(0, 14)}`);
    if (!v.proven) {
      show(await TT.rule_report(ctx, { id: r.id, status: "slop", note: `PoC did not prove the impact against the forked repo. ${v.note ?? ""}` }));
      continue;
    }
    if (v.severity) severity = v.severity; // proven severity overrides the claim
  }

  // Award = the program's committed payout for this severity (the advertised number).
  const award = payoutsOf(program)[severity] ?? AWARD[severity] ?? 0.5;
  console.log(`   VERDICT: valid (${severity}) → refund $${r.bondedUsd} bond + $${award} award`);

  if (dry) {
    show(await TT.rule_report(ctx, { id: r.id, status: "valid", note: "DRY RUN — no transfer", payoutUsd: award }));
    continue;
  }

  const refund = await TT.refund_bond(ctx, { id: r.id });
  console.log(`   refund:`, refund.ok ? `${refund.txHash} (${refund.explorerUrl})` : `FAILED: ${refund.error}`);
  const paid = await TT.pay_award(ctx, { id: r.id, awardUsd: award });
  console.log(`   award: `, paid.ok ? `${paid.txHash} (${paid.explorerUrl})` : `FAILED: ${paid.error}`);

  show(await TT.rule_report(ctx, {
    id: r.id, status: "valid",
    note: `Autonomous triage: valid ${r.severity}. Refund + $${award} award paid.`,
    refundTx: refund.ok ? refund.txHash : undefined,
    payoutTx: paid.ok ? paid.txHash : undefined,
    payoutUsd: award,
  }));
  console.log();
}

console.log("✓ triage pass complete");
