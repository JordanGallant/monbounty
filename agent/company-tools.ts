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
 * Assess the target's DEPLOYMENT before writing scope. Exploitability is a
 * property of code × deployment: the same repo can carry a "real" CVE that is
 * dead in production because the platform it runs on removes the exploited
 * surface (the textbook case being Next.js middleware auth bypass on Vercel).
 *
 * Given the platform + framework, this returns (a) a deployment profile to
 * commit alongside the verification recipe, and (b) suggested scopeOut lines for
 * classes commonly neutralised on that platform. The company confirms them — the
 * lines are proposals, hash-committed and shown to hunters once accepted, never
 * an automatic rejection.
 */
export async function assess_deployment(
  _ctx: CompanyContext,
  args: { platform: string; framework?: string; frameworkVersion?: string; runtime?: string; waf?: boolean; notes?: string },
) {
  const { normalizePlatform, neutralizedFor, describeSurface, PLATFORMS } = await import("../lib/deployment-context");
  const platform = normalizePlatform(args.platform);
  const profile = {
    platform,
    framework: args.framework?.trim() || undefined,
    frameworkVersion: args.frameworkVersion?.trim() || undefined,
    runtime: args.runtime?.trim() || undefined,
    waf: args.waf ?? undefined,
    notes: args.notes?.trim() || undefined,
  };
  const hits = neutralizedFor(profile);
  const surface = describeSurface(profile);
  return {
    deployment: profile,
    platformLabel: PLATFORMS[platform].label,
    verificationSurface: surface.surface,
    representativeInSandbox: surface.representative,
    suggestedScopeOut: hits.map((h) => h.scopeOutLine),
    neutralized: hits.map(({ id, title, reference, reason }) => ({ id, title, reference, reason })),
    note:
      hits.length === 0
        ? "No commonly-neutralised classes matched this platform. Write scope from the code as usual."
        : "Review these with the company. Fold the ones they confirm into scopeOut (they become hash-committed and " +
          "visible to hunters before they bond). Pass `deployment` into the verification recipe so verdicts name the " +
          "surface they proved against." +
          (surface.representative
            ? ""
            : " NOTE: the sandbox cannot reproduce this platform faithfully yet, so a 'proven' verdict here is labelled " +
              "non-representative — the company confirms against production before paying."),
  };
}

/**
 * The web3 counterpart of assess_deployment: assess a SMART CONTRACT target
 * before writing scope. Exploitability is code × VM — a class real on the EVM
 * can be impossible on Move or Solana (reentrancy on Move, delegatecall/storage
 * collision off-EVM, silent overflow on Solidity >=0.8 or Move).
 *
 * The target is ingested one of three ways: a deployed+verified contract
 * (strongest — fork the chain, run the PoC against real state), a source repo
 * (Foundry/Anchor/Move — build + fork), or an ABI/IDL only (black-box interface,
 * weakest). Returns a web3 target profile to commit with the onchain-fork recipe,
 * suggested scopeOut lines for classes not applicable on that VM, and the
 * VM-specific classes the company should make sure it prices.
 */
export async function assess_web3(
  _ctx: CompanyContext,
  args: {
    ecosystem?: string;            // evm | solana | aptos | sui | cosmwasm | polkadot
    language: string;              // solidity | vyper | move | rust
    sourceMode: "verified-onchain" | "abi-only" | "repo";
    contracts?: { address?: string; name?: string; verified?: boolean; abiProvided?: boolean }[];
    repo?: string;
    network?: string;
    forkBlock?: number;
    solidityGte08?: boolean;       // Solidity target on >=0.8 (checked arithmetic by default)?
    notes?: string;
  },
) {
  const {
    normalizeEcosystem, ecosystemFromLang, notApplicableFor, describeSource,
    ECOSYSTEMS, VM_IN_SCOPE_HINTS,
  } = await import("../lib/chain-context");
  const language = (args.language?.trim().toLowerCase() || "solidity") as any;
  const ecosystem = args.ecosystem ? normalizeEcosystem(args.ecosystem) : ecosystemFromLang(language);
  const eco = ECOSYSTEMS[ecosystem];
  const target = {
    ecosystem,
    language,
    network: args.network?.trim() || undefined,
    forkBlock: args.forkBlock,
    sourceMode: args.sourceMode,
    contracts: Array.isArray(args.contracts) ? args.contracts : [],
    repo: args.repo?.trim() || undefined,
    notes: args.notes?.trim() || undefined,
  };
  const na = notApplicableFor({ ecosystem, language, solidityGte08: args.solidityGte08 });
  const source = describeSource(target);
  return {
    target,
    ecosystemLabel: eco.label,
    vm: eco.vm,
    verificationApproach: source.approach,
    sourceComplete: source.complete,
    sourceNote: source.note,
    suggestedScopeOut: na.map((h) => h.scopeOutLine),
    notApplicable: na.map(({ id, title, reason }) => ({ id, title, reason })),
    shouldPrice: VM_IN_SCOPE_HINTS[eco.vm],
    note:
      "Review with the company. Fold confirmed suggestedScopeOut lines into scopeOut (hash-committed, shown to " +
      "hunters). Make sure the `shouldPrice` classes are covered by acceptedImpacts so scope isn't accidentally " +
      "too narrow. Carry `target` into the onchain-fork verification recipe." +
      (source.complete ? "" : " WARNING: ABI-only — a verdict can exercise the interface but cannot read logic; " +
        "prefer a verified deployment or source repo before opening a high-value pool."),
  };
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
  assess_deployment,
  assess_web3,
  propose_payouts,
  draft_bounty,
  provision_wallet,
  create_bounty,
  fund_pool,
  verify_bounty,
} as const;

export type CompanyToolName = keyof typeof COMPANY_TOOLS;
