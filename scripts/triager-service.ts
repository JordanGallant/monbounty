/**
 * triager-service — the company side as a long-running microservice.
 *
 * Polls the queue; for each report it verifies (fork + run the PoC) and pays out
 * on-chain, autonomously. Output is deliberately terse: one line per decision,
 * nothing while idle.
 *
 *   bun run scripts/triager-service.ts          # foreground
 *   (or via systemd: monbounty-triager.service)
 */
import { treasuryFromEnv } from "../agent/treasury";
import * as TT from "../agent/triager-tools";
import type { TriagerContext } from "../agent/triager-tools";
import { PUBLIC_URL } from "../lib/config";

const baseUrl = process.env.BOUNTY402_URL ?? PUBLIC_URL;
const network = (process.env.MONBOUNTY_NETWORK ?? "testnet") as any;
const every = Number(process.env.WATCH_INTERVAL ?? 8) * 1000;
if (!process.env.ADMIN_TOKEN) { console.error("ADMIN_TOKEN not set."); process.exit(1); }

const ctx: TriagerContext = { treasury: treasuryFromEnv(), baseUrl, adminToken: process.env.ADMIN_TOKEN };
const AWARD: Record<string, number> = { critical: 5, high: 3, medium: 1.5, low: 0.5, informational: 0.1 };
const t = () => new Date().toTimeString().slice(0, 8);
const s8 = (x = "") => x.slice(0, 8);
const tx8 = (x = "") => (x ? x.slice(0, 10) : "—");

console.log(`triager-service up · ${baseUrl} · net=${network} · treasury ${s8(ctx.treasury.address)}… · poll ${every / 1000}s`);

async function pass() {
  const programs = (await fetch(`${baseUrl}/api/programs`).then((x) => x.json()).catch(() => ({ programs: [] }))).programs ?? [];
  const modeOf = (slug: string) => programs.find((p: any) => p.slug === slug)?.verificationMode ?? "onchain-fork";
  const payoutsOf = (slug: string) => programs.find((p: any) => p.slug === slug)?.payouts ?? {};

  const { reports } = await TT.list_pending_reports(ctx);
  for (const r of reports) {
    const full = await TT.get_report(ctx, { id: r.id });
    const program = full.program ?? r.program;
    const hist = await TT.get_hunter_history(ctx, { address: r.hunter });

    if (hist.tier === "penalised") {
      await TT.rule_report(ctx, { id: r.id, status: "slop", note: "Penalised hunter — auto-rejected." });
      console.log(`${t()}  ✗ ${s8(r.id)} ${r.severity} slop (penalised hunter)`);
      continue;
    }

    let severity = r.severity;
    if (modeOf(program) === "company-attested") {
      let poc: any; try { poc = JSON.parse(full.poc ?? ""); } catch {}
      const v = await TT.verify_submission(ctx, { program, id: r.id, poc });
      if (!v.proven) {
        await TT.rule_report(ctx, { id: r.id, status: "slop", note: `PoC not proven. ${v.note ?? ""}` });
        console.log(`${t()}  ✗ ${s8(r.id)} ${r.severity} slop (PoC not proven)`);
        continue;
      }
      if (v.severity) severity = v.severity;
    }

    const award = payoutsOf(program)[severity] ?? AWARD[severity] ?? 0.5;
    const refund = await TT.refund_bond(ctx, { id: r.id });
    const paid = await TT.pay_award(ctx, { id: r.id, awardUsd: award });
    await TT.rule_report(ctx, {
      id: r.id, status: "valid",
      note: `Autonomous: valid ${severity}. Refund + $${award} award.`,
      refundTx: refund.ok ? refund.txHash : undefined,
      payoutTx: paid.ok ? paid.txHash : undefined,
      payoutUsd: award,
    });

    if (refund.ok && paid.ok)
      console.log(`${t()}  ✓ ${s8(r.id)} ${severity} valid → $${(r.bondedUsd + award).toFixed(2)} to ${s8(r.hunter)}… (award ${tx8(paid.txHash)})`);
    else
      console.log(`${t()}  ⚠ ${s8(r.id)} ${severity} valid but payout FAILED: ${paid.error ?? refund.error}`);
  }
}

for (;;) {
  try { await pass(); } catch (e: any) { console.log(`${t()}  ! error ${e?.message ?? e}`); }
  await new Promise((r) => setTimeout(r, every));
}
