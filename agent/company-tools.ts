/**
 * Company-side toolkit: how an agent onboards a bounty. Framework-agnostic —
 * agent/company.ts drives it with Claude, scripts/company-flow.ts runs it in a
 * fixed order with no API key. Mirrors the hunter toolkit in agent/tools.ts.
 *
 * The flow: read the target, propose an impact-based payout table (the human
 * sets the prices, the agent verifies the severity bands), draft the rules,
 * provision a wallet, create the bounty (which commits the rulesHash), fund the
 * reward pool, and verify the bounty is both hash-verified and solvent.
 */
import { readFileSync } from "node:fs";
import type { NetKey } from "../lib/config";

export interface CompanyContext {
  baseUrl: string;
  network: NetKey;
  /** The address that will grade submissions — the company's wallet. */
  ruler: string;
  /** Optional bearer token for a Circle-provisioned wallet. */
  walletToken?: string;
  /** Slug set once the bounty is created, so later tools can act on it. */
  slug?: string;
}

async function j(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

// ── read-only ────────────────────────────────────────────────────────────────

export function read_target(_ctx: CompanyContext, args: { path?: string; text?: string }) {
  if (args.text) return { source: "inline", length: args.text.length, content: args.text.slice(0, 60_000) };
  if (!args.path) return { error: "provide either path or text" };
  try {
    const content = readFileSync(args.path, "utf8");
    return { source: args.path, length: content.length, content: content.slice(0, 60_000) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function list_impacts(ctx: CompanyContext) {
  return j(await fetch(`${ctx.baseUrl}/api/severity`));
}

/**
 * Build a payout table from a preset or a TVL, with optional per-severity
 * overrides. Returns the table plus whether it is monotonic — the human's
 * prices ride on top, the tool just checks the shape is payable.
 */
export async function propose_payouts(
  ctx: CompanyContext,
  args: { preset?: "onchain" | "web2"; tvlUsd?: number; overrides?: Record<string, number> },
) {
  const sev = await list_impacts(ctx);
  const base = args.preset ? sev.presets?.[args.preset] : sev.presets?.onchain;
  const table = { ...(base ?? {}) };
  if (args.tvlUsd && table) {
    // Critical as a share of funds at risk, floored — the on-chain convention.
    table.critical = Math.min(1_000_000, Math.max(50_000, Math.round(args.tvlUsd * 0.1)));
  }
  for (const [k, v] of Object.entries(args.overrides ?? {})) table[k] = Number(v);
  return { payouts: table, note: "Confirm these with the human before creating the bounty. Must be monotonic." };
}

// ── draft (no side effects) ────────────────────────────────────────────────

export interface BountyDraft {
  slug: string;
  name: string;
  target: string;
  scopeIn: string[];
  scopeOut: string[];
  acceptedImpacts: string[];
  payouts: Record<string, number>;
  slaSeconds?: number;
  bondUsd?: number;
  tvlUsd?: number;
}

/**
 * Validate a draft WITHOUT creating it — catches a non-monotonic table, an
 * unknown impact id, a bad slug, before anything is committed. Mirrors the
 * hunter's draft_writeup. Returns the rulesHash the create call will commit, so
 * the agent can show the human exactly what is about to be locked in.
 */
export async function draft_bounty(ctx: CompanyContext, d: BountyDraft) {
  // Validate locally via the exact same rules the server uses — no dry-run
  // route needed, and nothing is committed.
  const { validateRules } = await import("../lib/rules");
  const { IMPACT_BY_ID } = await import("../lib/severity");
  const SEV = ["critical", "high", "medium", "low", "informational"] as const;
  const payouts: any = {};
  for (const s of SEV) payouts[s] = Number(d.payouts?.[s] ?? 0);
  if (d.tvlUsd && !payouts.critical) payouts.critical = Math.min(1_000_000, Math.max(50_000, Math.round(d.tvlUsd * 0.1)));
  const rules = {
    slug: d.slug.trim().toLowerCase(), name: d.name, target: d.target,
    scopeIn: d.scopeIn ?? [], scopeOut: d.scopeOut ?? [],
    payouts, acceptedImpacts: d.acceptedImpacts ?? [],
    slaSeconds: d.slaSeconds ?? 7 * 24 * 3600, ruler: ctx.ruler,
  };
  const badImpacts = (d.acceptedImpacts ?? []).filter((id) => !IMPACT_BY_ID.has(id));
  if (badImpacts.length) return { ok: false, problems: [`unknown impact id(s): ${badImpacts.join(", ")}`] };
  const v = validateRules(rules as any);
  if (!v.ok) return { ok: false, problems: [v.error] };
  const { rulesHash, bountyOnchainParams } = await import("../lib/rules");
  return {
    ok: true,
    rulesHash: rulesHash(rules as any),
    onchain: bountyOnchainParams(rules as any),
    rewardPoolUsd: payouts.critical,
    machineCheckable: (d.acceptedImpacts ?? []).filter((id) => IMPACT_BY_ID.get(id)?.invariant),
  };
}

// ── side effects ───────────────────────────────────────────────────────────

/**
 * Provision the company's wallet. With a Circle key configured this creates one
 * server-side; otherwise it uses the ruler address already in the context (the
 * env treasury), so the demo runs with no external signup.
 */
export async function provision_wallet(ctx: CompanyContext, args: { label?: string } = {}) {
  const res = await fetch(`${ctx.baseUrl}/api/v1/wallets`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: ctx.network, label: args.label ?? "company" }),
  });
  if (res.status === 501) {
    return { provisioned: false, using: "env wallet", ruler: ctx.ruler,
      note: "Circle not configured on this deployment; using the treasury address as the grading wallet." };
  }
  const data = await j(res);
  if (data?.address) { ctx.ruler = data.address; ctx.walletToken = data.walletToken; }
  return { provisioned: true, ...data };
}

export async function create_bounty(ctx: CompanyContext, d: BountyDraft) {
  const res = await fetch(`${ctx.baseUrl}/api/programs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: d.slug, name: d.name, target: d.target, scopeIn: d.scopeIn, scopeOut: d.scopeOut,
      acceptedImpacts: d.acceptedImpacts, payouts: d.payouts, slaSeconds: d.slaSeconds,
      bondUsd: d.bondUsd ?? 1, tvlUsd: d.tvlUsd ?? null, ruler: ctx.ruler, createdBy: "company-agent",
    }),
  });
  const data = await j(res);
  if (data?.slug) ctx.slug = data.slug;
  return data;
}

export async function fund_pool(ctx: CompanyContext, args: { amountUsd: number; confirmed?: boolean }) {
  if (!ctx.slug) return { error: "no bounty created yet — call create_bounty first" };
  const res = await fetch(`${ctx.baseUrl}/api/programs/${ctx.slug}/fund`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUsd: args.amountUsd, network: ctx.network, confirmed: args.confirmed ?? false }),
  });
  return j(res);
}

export async function verify_bounty(ctx: CompanyContext) {
  if (!ctx.slug) return { error: "no bounty created yet" };
  return j(await fetch(`${ctx.baseUrl}/api/programs/${ctx.slug}/rules`));
}

export const COMPANY_TOOLS = {
  read_target,
  list_impacts,
  propose_payouts,
  draft_bounty,
  provision_wallet,
  create_bounty,
  fund_pool,
  verify_bounty,
} as const;

export type CompanyToolName = keyof typeof COMPANY_TOOLS;
