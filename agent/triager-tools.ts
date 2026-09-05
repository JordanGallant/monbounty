/**
 * Agent 2's toolkit — the autonomous triager/payer.
 *
 * Agent 2 is the program side of the loop. It reads a submission and the
 * hunter's on-chain-ish identity, decides whether the finding is real and in
 * scope, and — with no human in the loop — pays the bond refund and the bounty
 * award straight back to the hunter's wallet. The bounty rail is a direct USDC
 * transfer (a payout is a push; x402 is the pull side used for intake).
 *
 * These functions hold the ADMIN_TOKEN: Agent 2 IS the program operator.
 */
import { Treasury } from "./treasury";
import { netById, type NetKey } from "../lib/config";

export interface TriagerContext {
  treasury: Treasury;
  baseUrl: string;
  adminToken: string;
}

const auth = (ctx: TriagerContext) => ({ Authorization: `Bearer ${ctx.adminToken}` });
async function j(res: Response) {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
}
function netKeyOf(networkId: string): NetKey {
  return (netById(networkId)?.key ?? "testnet");
}

// ── read ────────────────────────────────────────────────────────────────────

/** Reports queued for triage (PoC paid). Includes summary + PoC for review. */
export async function list_pending_reports(ctx: TriagerContext) {
  const data = await j(await fetch(`${ctx.baseUrl}/api/admin/reports?status=triaging`, { headers: auth(ctx) }));
  return {
    // The EVM triager settles on Monad; Solana-bonded reports are settled by the
    // Solana path (demo/hunter/solana-settle.ts), so they're excluded here.
    reports: (data.reports ?? []).filter((r: any) => r.network !== "solana-devnet").map((r: any) => ({
      id: r.id,
      program: r.program,
      hunter: r.payer,
      title: r.title,
      severity: r.severity,
      asset: r.asset,
      summary: r.summary,
      poc: r.poc,
      network: r.network,
      bondedUsd: (r.bond_usd ?? 0) + (r.poc_bond_usd ?? 0),
      createdAt: r.created_at,
    })),
  };
}

export async function get_report(ctx: TriagerContext, args: { id: string }) {
  return j(await fetch(`${ctx.baseUrl}/api/admin/reports/${args.id}`, { headers: auth(ctx) }));
}

/** The hunter's track record — the identity/history signal for the gate. */
export async function get_hunter_history(ctx: TriagerContext, args: { address: string }) {
  const r = await j(await fetch(`${ctx.baseUrl}/api/hunters/${args.address}`));
  return {
    address: args.address,
    tier: r.tier,
    bondMultiplier: r.bondMultiplier,
    submitted: r.submitted,
    valid: r.valid,
    slop: r.slop,
    signalRate: r.signalRate,
    paidOutUsd: r.paidOutUsd,
    history: (r.history ?? []).slice(0, 20),
    gateHint:
      r.tier === "penalised"
        ? "This hunter has a history of slop. Consider an instant refund + reject without deep review."
        : r.tier === "proven"
        ? "Proven track record. Review can be lighter, but still confirm the finding is real."
        : "No strong signal either way — review the finding on its merits.",
  };
}

// ── the overseer gate ────────────────────────────────────────────────────────

/**
 * Everything this agent does is reversible except paying. A payout is a push
 * transaction the treasury signs itself — no facilitator, no escrow, no way to
 * unwind it — so it is the one step a human holds.
 *
 * Set OVERSEER_REQUIRED=0 to run the loop fully unattended (that is what
 * scripts/triager-flow.ts --dry does, and what the two-agent demo does on
 * testnet). Leave it on for anything moving real money.
 */
const OVERSEER_REQUIRED = process.env.OVERSEER_REQUIRED !== "0";
const APPROVAL_TIMEOUT_SEC = Number(process.env.APPROVAL_TIMEOUT_SEC ?? 900);

async function awaitApproval(
  ctx: TriagerContext,
  args: { id: string; kind: "refund" | "award"; amountUsd: number; rationale?: string },
): Promise<{ ok: true } | { ok: false; error: string; approvalId?: string; state?: string }> {
  if (!OVERSEER_REQUIRED) return { ok: true };

  const created = await j(
    await fetch(`${ctx.baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportId: args.id,
        kind: args.kind,
        amountUsd: args.amountUsd,
        rationale: args.rationale,
      }),
    }),
  );
  if (!created?.id) return { ok: false, error: "approval_request_failed" };

  const deadline = Date.now() + APPROVAL_TIMEOUT_SEC * 1000;
  while (Date.now() < deadline) {
    const a = await j(await fetch(`${ctx.baseUrl}/api/approvals/${created.id}`));
    if (a?.state === "approved") return { ok: true };
    if (a?.state === "rejected")
      return { ok: false, error: "rejected_by_overseer", approvalId: created.id, state: a.state };
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, error: "approval_timeout", approvalId: created.id, state: "pending" };
}

// ── pay (autonomous up to the gate) ──────────────────────────────────────────

/** Refund the hunter's bond (valid or good-faith duplicate). Real USDC transfer. */
/**
 * Verify a submission for a company-attested bounty: fork the program's repo
 * into a sandbox, run it, replay the hunter PoC, and check the committed impact
 * assertion. Returns a signed verdict + evidence hash — proof the finding is
 * real, without the code ever leaving the sandbox. Use this BEFORE paying on a
 * company-attested program.
 */
export async function verify_submission(ctx: TriagerContext, args: { program: string; id: string; poc?: any }) {
  return j(await fetch(`${ctx.baseUrl}/api/programs/${args.program}/reports/${args.id}/verify`, {
    method: "POST", headers: { ...auth(ctx), "content-type": "application/json" },
    body: JSON.stringify({ poc: args.poc }),
  }));
}

export async function refund_bond(ctx: TriagerContext, args: { id: string }) {
  const r = await get_report(ctx, { id: args.id });
  if (r.error) return { ok: false, error: r.error };
  const amount = (r.bond_usd ?? 0) + (r.poc_bond_usd ?? 0);
  const gate = await awaitApproval(ctx, {
    id: args.id,
    kind: "refund",
    amountUsd: amount,
    rationale: `Refund the bond on "${r.title}" (${r.severity}).`,
  });
  if (!gate.ok) return { ...gate, reportId: args.id, kind: "refund" };
  const pay = await ctx.treasury.pay(r.payer, amount, netKeyOf(r.network));
  return { ...pay, reportId: args.id, kind: "refund" };
}

/** Pay a bounty award to the hunter. Real USDC transfer, agent-to-agent. */
export async function pay_award(ctx: TriagerContext, args: { id: string; awardUsd: number }) {
  const r = await get_report(ctx, { id: args.id });
  if (r.error) return { ok: false, error: r.error };
  const gate = await awaitApproval(ctx, {
    id: args.id,
    kind: "award",
    amountUsd: args.awardUsd,
    rationale: `Pay a $${args.awardUsd} award for "${r.title}" (${r.severity}).`,
  });
  if (!gate.ok) return { ...gate, reportId: args.id, kind: "award" };
  const pay = await ctx.treasury.pay(r.payer, args.awardUsd, netKeyOf(r.network));
  return { ...pay, reportId: args.id, kind: "award" };
}

// ── rule (write the verdict, with the payout receipts) ───────────────────────

/**
 * Record the verdict. Pass the tx hashes from refund_bond / pay_award so the
 * report shows the on-chain proof that the hunter was actually paid.
 */
export async function rule_report(
  ctx: TriagerContext,
  args: { id: string; status: "valid" | "duplicate" | "out_of_scope" | "slop"; note?: string; refundTx?: string; payoutUsd?: number; payoutTx?: string },
) {
  const res = await fetch(`${ctx.baseUrl}/api/admin/reports/${args.id}/verdict`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(ctx) },
    body: JSON.stringify(args),
  });
  return j(res);
}

export const TRIAGER_TOOLS = {
  verify_submission,
  list_pending_reports, get_report, get_hunter_history, refund_bond, pay_award, rule_report,
} as const;
export type TriagerToolName = keyof typeof TRIAGER_TOOLS;
