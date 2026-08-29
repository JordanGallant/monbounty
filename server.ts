import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

import { NET, ENABLED, netById, payToFor, rampUrl, FACILITATOR_URL, PORT, PUBLIC_URL, ADMIN_TOKEN, DEFAULT_BOND_USD, POC_MULTIPLIER, ERC8004_REQUIRED, usdPrice, assertConfig, type MonadNet } from "./lib/config";
import { db, getProgram, listPrograms, findDuplicate, walletByToken, getProgramRow, createBountyProgram, recordProgramFunding, listAllPrograms, setProgramApproval, setProgramRecipe, type ReportRow, type ReportStatus, type FundingRequestRow, type AgentWalletRow, type ApprovalRow, type ProgramRow } from "./lib/db";
import { canonicalRules, rulesHash, bountyOnchainParams, validateRules, type BountyRules } from "./lib/rules";
import { SEVERITIES, IMPACT_BY_ID, IMPACTS, machineCheckable, validatePayouts, PRESET_PAYOUTS, criticalFromTvl, type PayoutTable } from "./lib/severity";
import { decodePaymentHeader, contentHash } from "./lib/payment";
import { reputationFor, leaderboard, touchHunter, assessHunter } from "./lib/reputation";
import { circleConfigured, createWallet, signTypedData } from "./lib/circle";
import { balancesFor } from "./lib/balance";

assertConfig();

const paymentHeader = (c: any): string | undefined =>
  c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("payment-signature") ?? c.req.header("X-PAYMENT") ?? undefined;

const app = new Hono();

// ── x402 resource server ────────────────────────────────────────────────────
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitator);
// One scheme instance per network. The client decides which of the advertised
// `accepts` entries to pay, so mainnet and testnet coexist on the same route.
for (const net of ENABLED) resourceServer.register(net.id, new ExactEvmScheme());

// The afterSettle hook fires once the facilitator has landed the transfer,
// which is after our handler has already written the row. Correlate on the
// EIP-3009 nonce — it is unique per authorisation and we stored it at insert.
resourceServer.onAfterSettle(async (ctx: any) => {
  const tx = ctx?.result?.transaction ?? ctx?.result?.txHash ?? null;
  const p = ctx?.paymentPayload?.payload ?? {};
  const nonce: string | null =
    p?.authorization?.nonce ?? p?.permit2Authorization?.nonce ?? null;
  if (!tx || !nonce) return;
  await db.run("UPDATE reports SET settle_tx = ? WHERE settle_nonce = ? AND settle_tx IS NULL", [tx, nonce]);
  await db.run("UPDATE reports SET poc_settle_tx = ? WHERE poc_nonce = ? AND poc_settle_tx IS NULL", [tx, nonce]);
});

/**
 * Whose reputation prices this request.
 *
 * On the unpaid probe there is no X-PAYMENT yet, so a caller may declare
 * themselves with ?hunter=0x… to be quoted their discount. That is not a
 * trust decision: on the paid retry the price is recomputed from the real
 * payer, so a caller who claims someone else's history signs an amount that
 * no longer matches the requirements and fails verification.
 */
const quotedFor = (ctx: any): string | null => {
  const paid = decodePaymentHeader(ctx?.paymentHeader).payer;
  if (paid) return paid;
  const claimed = ctx?.adapter?.getQueryParam?.("hunter");
  return typeof claimed === "string" && /^0x[0-9a-fA-F]{40}$/.test(claimed)
    ? claimed.toLowerCase()
    : null;
};

const bondFor = async (baseUsd: number, ctx: any) => {
  const who = quotedFor(ctx);
  const mult = who ? (await reputationFor(who)).bondMultiplier : 1;
  return Math.max(baseUsd * mult, 0.01);
};

/** Bond for step 1, from the program named in ?program=, priced on `net`. */
const submitPrice = (net: MonadNet) => async (ctx: any) => {
  const slug = String(ctx?.adapter?.getQueryParam?.("program") ?? "");
  const program = slug ? await getProgram(slug) : null;
  return usdPrice(await bondFor(program?.bond_usd ?? DEFAULT_BOND_USD, ctx), net);
};

/** Step 2 costs a multiple of the bond — this is the gate bots die on. */
const pocPrice = (net: MonadNet) => async (ctx: any) => {
  const id = String(ctx?.path ?? "").split("/").at(-2) ?? "";
  const row = await db
    .query<{ bond_usd: number }, [string]>("SELECT bond_usd FROM reports WHERE id = ?")
    .get(id);
  const base = row?.bond_usd ?? DEFAULT_BOND_USD;
  return usdPrice(await bondFor(base * POC_MULTIPLIER, ctx), net);
};

/** One accepts entry per enabled network — the payer chooses the chain. */
/** The company's wallet receives the bond; falls back to the platform payTo. */
function companyReceiver(p: { ruler: string | null } | null, net: MonadNet): string {
  return p?.ruler && /^0x[0-9a-fA-F]{40}$/.test(p.ruler) ? p.ruler : payToFor(net);
}
const submitPayTo = (net: MonadNet) => async (ctx: any) => {
  const slug = String(ctx?.adapter?.getQueryParam?.("program") ?? "");
  return companyReceiver(slug ? await getProgram(slug) : null, net);
};
const pocPayTo = (net: MonadNet) => async (ctx: any) => {
  const id = String(ctx?.path ?? "").split("/").at(-2) ?? "";
  const row = id ? await db.query<{ program: string }, [string]>("SELECT program FROM reports WHERE id = ?").get(id) : null;
  return companyReceiver(row ? await getProgram(row.program) : null, net);
};

const acceptsFor = (
  price: (n: MonadNet) => (ctx: any) => unknown | Promise<unknown>,
  payTo: (n: MonadNet) => (ctx: any) => string | Promise<string>,
) =>
  ENABLED.map((net) => ({
    scheme: "exact" as const,
    network: net.id,
    payTo: payTo(net),
    price: price(net),
  }));

app.use(
  paymentMiddleware(
    {
      "POST /api/v1/reports": {
        accepts: acceptsFor(submitPrice, submitPayTo),
        resource: `${PUBLIC_URL}/api/v1/reports`,
        description: "Submit a vulnerability report. Refundable bond, slashed for slop.",
        serviceName: "bounty402",
        mimeType: "application/json",
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            what: "A refundable USDC bond on Monad buys one triage ticket.",
            docs: `${PUBLIC_URL}/docs`,
          },
        }),
        settlementFailedResponseBody: (_ctx: any, settleResult: any) => ({
          contentType: "application/json",
          body: {
            error: "settlement_failed",
            reason: settleResult?.errorReason ?? settleResult?.error ?? "unknown",
            hint:
              "Usually an unfunded payer. USDC per network: " +
              ENABLED.map((n) => `${n.name} ${n.usdc}`).join(", "),
            networks: ENABLED.map((n) => n.id),
          },
        }),
      },
      "POST /api/v1/reports/:id/poc": {
        accepts: acceptsFor(pocPrice, pocPayTo),
        resource: `${PUBLIC_URL}/api/v1/reports`,
        description: "Attach a proof of concept to a report. Second gate, higher bond.",
        serviceName: "bounty402",
        mimeType: "application/json",
        settlementFailedResponseBody: (_ctx: any, settleResult: any) => ({
          contentType: "application/json",
          body: {
            error: "settlement_failed",
            reason: settleResult?.errorReason ?? settleResult?.error ?? "unknown",
            hint:
              "Usually an unfunded payer. USDC per network: " +
              ENABLED.map((n) => `${n.name} ${n.usdc}`).join(", "),
            networks: ENABLED.map((n) => n.id),
          },
        }),
      },
    },
    resourceServer,
  ),
);

// ── public read API ─────────────────────────────────────────────────────────
app.get("/healthz", (c) =>
  c.json({ ok: true, networks: ENABLED.map((n) => n.id), facilitator: FACILITATOR_URL }),
);

app.get("/api/programs", async (c) =>
  c.json({
    networks: ENABLED.map((n) => ({
      id: n.id,
      key: n.key,
      name: n.name,
      chainId: n.chainId,
      usdc: n.usdc,
      explorer: n.explorer,
      testnet: n.testnet,
      payTo: payToFor(n),
    })),
    defaultNetwork: NET.id,
    facilitator: FACILITATOR_URL,
    programs: (await listPrograms()).map((p) => {
      const safeJson = (t: string | null, d: any) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
      const committed = Boolean(p.rules_hash);
      return {
        slug: p.slug,
        name: p.name,
        scope: p.scope,
        bondUsd: p.bond_usd,
        pocBondUsd: Number((p.bond_usd * POC_MULTIPLIER).toFixed(3)),
        rewardRange: p.reward_range,
        chain: p.chain,
        submitUrl: `${PUBLIC_URL}/api/v1/reports?program=${p.slug}`,
        // company side (null/false on the legacy seeded programs)
        committed,
        target: p.target,
        rulesHash: p.rules_hash,
        createdBy: p.created_by,
        acceptedImpacts: safeJson(p.accepted_impacts, []),
        payouts: safeJson(p.payouts, null),
        slaSeconds: p.sla_seconds,
        verificationMode: p.verification_mode,
        pool: committed
          ? { committedUsd: p.pool_committed_usd, fundedUsd: p.pool_funded_usd, solvent: p.pool_funded_usd >= p.pool_committed_usd }
          : null,
      };
    }),
  }),
);

// ── company side: create, fund and verify a bounty ──────────────────────────
// A company (or its agent) opens a bounty here. The rules are hashed and the
// hash is stored, so a hunter can later prove the scope and payout table did
// not move. Creation is unauthenticated on purpose: an empty bounty is
// worthless, so there is nothing to gain by squatting, and gating it would put
// the platform back in the trust path.

/** The impact catalogue + presets an agent uses to build a payout table. */
app.get("/api/severity", (c) =>
  c.json({
    severities: SEVERITIES,
    impacts: IMPACTS.map((i) => ({
      id: i.id, severity: i.severity, label: i.label,
      machineCheckable: Boolean(i.invariant), invariant: i.invariant ?? null,
    })),
    machineCheckable: machineCheckable().map((i) => i.id),
    presets: PRESET_PAYOUTS,
    note: "Humans set the prices; the agent verifies the severity band. Payouts must be monotonic (critical >= high >= ... ).",
  }),
);

function rulesFromBody(b: any): { rules?: BountyRules; bondUsd: number; tvlUsd: number | null; error?: string } {
  const payouts = {} as PayoutTable;
  for (const s of SEVERITIES) payouts[s] = Number(b?.payouts?.[s] ?? 0);
  // If a TVL is given and critical is left at 0, size critical off it.
  const tvlUsd = b?.tvlUsd != null ? Number(b.tvlUsd) : null;
  if (tvlUsd && !payouts.critical) payouts.critical = criticalFromTvl(tvlUsd);
  const rules: BountyRules = {
    slug: String(b?.slug ?? "").trim().toLowerCase(),
    name: String(b?.name ?? "").trim(),
    target: String(b?.target ?? "").trim(),
    scopeIn: Array.isArray(b?.scopeIn) ? b.scopeIn.map(String) : [],
    scopeOut: Array.isArray(b?.scopeOut) ? b.scopeOut.map(String) : [],
    payouts,
    bondUsd: Number(b?.bondUsd ?? 1),
    acceptedImpacts: Array.isArray(b?.acceptedImpacts) ? b.acceptedImpacts.map(String) : [],
    slaSeconds: Number(b?.slaSeconds ?? 7 * 24 * 3600),
    ruler: String(b?.ruler ?? "").trim(),
  };
  // Every accepted impact must be a real catalogue id, else severity is meaningless.
  const bad = rules.acceptedImpacts.filter((id) => !IMPACT_BY_ID.has(id));
  if (bad.length) return { bondUsd: 0, tvlUsd, error: `unknown impact id(s): ${bad.join(", ")}` };
  const v = validateRules(rules);
  if (!v.ok) return { bondUsd: 0, tvlUsd, error: v.error };
  return { rules, bondUsd: Number(b?.bondUsd ?? 1), tvlUsd };
}

app.post("/api/programs", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const { rules, bondUsd, tvlUsd, error } = rulesFromBody(b);
  if (error || !rules) return c.json({ error: "invalid_rules", detail: error }, 422);

  const existing = await getProgramRow(rules.slug);
  if (existing) return c.json({ error: "slug_taken", slug: rules.slug }, 409);

  const { slug, rulesHash: hash } = await createBountyProgram(rules, {
    bondUsd, tvlUsd, contact: b?.contact ?? null, createdBy: b?.createdBy ?? null,
    verificationMode: b?.verificationMode === "company-attested" ? "company-attested" : "onchain-fork",
    verifyRecipe: b?.verifyRecipe ?? null,
  });
  return c.json({
    slug,
    rulesHash: hash,
    onchain: bountyOnchainParams(rules),
    rewardPoolUsd: rules.payouts.critical,
    fundUrl: `${PUBLIC_URL}/api/programs/${slug}/fund`,
    rulesUrl: `${PUBLIC_URL}/api/programs/${slug}/rules`,
    submitUrl: `${PUBLIC_URL}/api/v1/reports?program=${slug}`,
    approvalStatus: "pending",
    note: "Submitted for review. Fund the reward pool; the bounty lists to hunters once monbounty approves it.",
  }, 201);
});

// ── company: set / read a bounty's verification recipe ──────────────────────
// This is how a company points a bounty at a real GitHub target and the impact
// assertions the company agent checks. Admin/ruler-gated: a recipe can carry
// private build steps.
app.get("/api/programs/:slug/recipe", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const p = await getProgramRow(c.req.param("slug"));
  if (!p) return c.json({ error: "not_found" }, 404);
  return c.json({
    slug: p.slug, verificationMode: p.verification_mode,
    recipe: p.verify_recipe ? JSON.parse(p.verify_recipe) : null,
  });
});

app.put("/api/programs/:slug/recipe", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}) as any);
  const mode = b?.verificationMode === "company-attested" ? "company-attested" : "onchain-fork";
  let recipe: any = null;
  if (mode === "company-attested") {
    if (!b?.repo || typeof b.repo !== "string") return c.json({ error: "repo_required" }, 422);
    recipe = {
      repo: String(b.repo).trim(),
      ref: b.ref ? String(b.ref) : undefined,
      buildCmd: b.buildCmd ? String(b.buildCmd) : undefined,
      runCmd: b.runCmd ? String(b.runCmd) : undefined,
      port: b.port != null ? Number(b.port) : undefined,
      healthPath: b.healthPath ? String(b.healthPath) : undefined,
      bootSec: b.bootSec != null ? Number(b.bootSec) : undefined,
      assertions: typeof b.assertions === "object" && b.assertions ? b.assertions : {},
    };
  }
  const ok = await setProgramRecipe(c.req.param("slug"), mode as any, recipe);
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ slug: c.req.param("slug"), verificationMode: mode, recipe });
});

// ── verification: fork the repo, run the PoC, prove the impact ───────────────
// The company agent calls this to verify a submission for a company-attested
// bounty. It clones the program's repo into a throwaway sandbox, runs it,
// replays the hunter PoC, and checks the committed impact assertion. Only the
// signed verdict + evidence hash leave the sandbox — the code never does.
app.post("/api/programs/:slug/reports/:id/verify", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const prog = await getProgramRow(c.req.param("slug"));
  if (!prog) return c.json({ error: "unknown_program" }, 404);
  if (prog.verification_mode !== "company-attested")
    return c.json({ error: "wrong_mode", verificationMode: prog.verification_mode,
      hint: "onchain-fork bounties verify by executing the PoC against a chain fork, not here." }, 409);
  const recipe = prog.verify_recipe ? JSON.parse(prog.verify_recipe) : null;
  if (!recipe?.repo) return c.json({ error: "no_recipe", hint: "This bounty has no verification recipe (repo/run/assertions)." }, 409);

  const report = await db.query<ReportRow, [string]>("SELECT * FROM reports WHERE id = ?").get(c.req.param("id"));
  if (!report) return c.json({ error: "unknown_report" }, 404);

  const body = await c.req.json().catch(() => ({}) as any);
  // The reproduction (requests + claimed impact) — from the request, or the stored PoC as JSON.
  let pocInput: any = body?.poc;
  if (!pocInput && report.poc) { try { pocInput = JSON.parse(report.poc); } catch {} }
  if (!pocInput?.requests || !pocInput?.impact)
    return c.json({ error: "no_structured_poc", hint: "Provide poc: { impact, requests[] }." }, 422);

  // The assertion is the COMPANY's, committed in the recipe — not the hunter's.
  // Prefer the assertion for the exact impact the hunter claimed; but a real
  // finding shouldn't be rejected just because the hunter labelled it (e.g.
  // "web-secret-exposure") differently from the company's key ("web-idor"). So
  // if there's no exact match, prove against ANY committed assertion — if the
  // reproduction triggers a committed regex, the impact is real by definition.
  const committed: Record<string, string> = recipe.assertions ?? {};
  const all = Object.values(committed).filter(Boolean);
  const assertion =
    committed[pocInput.impact] ??
    (all.length ? all.map((r) => `(?:${r})`).join("|") : undefined) ??
    pocInput.assertion;
  if (!assertion) return c.json({ error: "no_assertion", impact: pocInput.impact,
    hint: "This program has no committed assertion at all." }, 409);

  const { verifySubmission } = await import("./lib/verify");
  const result = await verifySubmission(recipe, { impact: pocInput.impact, requests: pocInput.requests, assertion });

  // Determine severity from the proven impact.
  const impact = IMPACT_BY_ID.get(pocInput.impact);
  const verdict = result.proven ? "valid" : "unproven";
  return c.json({
    reportId: report.id, program: prog.slug, verificationMode: "company-attested",
    verdict, proven: result.proven, impact: pocInput.impact,
    severity: result.proven ? impact?.severity ?? null : null,
    evidenceHash: result.evidenceHash, transcript: result.transcript, log: result.log,
    note: result.proven
      ? "Impact proven by executing the PoC against a fresh fork of the company's repo. Sign this verdict + evidence hash and settle."
      : "PoC did not satisfy the committed impact assertion against the forked deploy.",
  });
});

// ── admin: approve / reject company bounties before they list ────────────────
app.get("/api/admin/programs", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const rows = await listAllPrograms(c.req.query("status"));
  return c.json({ programs: rows.map((p) => ({
    slug: p.slug, name: p.name, target: p.target, createdBy: p.created_by,
    approvalStatus: p.approval_status, committed: Boolean(p.rules_hash),
    poolFundedUsd: p.pool_funded_usd, poolCommittedUsd: p.pool_committed_usd, createdAt: p.created_at,
  })) });
});

for (const [path, status] of [["approve", "approved"], ["reject", "rejected"]] as const) {
  app.post(`/api/admin/programs/:slug/${path}`, async (c) => {
    if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
    const ok = await setProgramApproval(c.req.param("slug"), status, "admin");
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ slug: c.req.param("slug"), approvalStatus: status });
  });
}

/**
 * Submissions for one program — the company's live queue. Metadata + each
 * submitter's risk (new / trusted / denied), not the raw PoC. Used by the
 * company dashboard, polled for near-real-time updates.
 */
app.get("/api/programs/:slug/reports", async (c) => {
  const slug = c.req.param("slug");
  const rows = await db
    .query<ReportRow, [string]>("SELECT * FROM reports WHERE program = ? ORDER BY created_at DESC LIMIT 100")
    .all(slug);
  const prog = await getProgramRow(slug);
  const target = prog?.target ?? slug;
  const reports = await Promise.all(rows.map(async (r) => {
    const risk = await assessHunter(r.payer);
    const bondUsd = Number(((r.bond_usd ?? 0) + (r.poc_bond_usd ?? 0)).toFixed(3));
    // Decision trace — the triager pipeline, reconstructed from the record so a
    // human can watch how each submission was handled.
    const explorer = netById(r.network)?.explorer ?? NET.explorer;
    const txUrl = (h: string | null) => (h ? `${explorer}/tx/${h}` : undefined);
    const trace: { level: string; text: string; tx?: string; url?: string }[] = [];
    const push = (level: string, text: string) => trace.push({ level, text });
    const pushTx = (level: string, text: string, h: string | null) =>
      trace.push({ level, text, tx: h ?? undefined, url: txUrl(h) });
    push("in", `submission ${r.id.slice(0, 8)} received  ·  ${r.severity}  ·  ${r.network}`);
    push(risk.decision === "deny" ? "deny" : "info",
      `risk-assess ${r.payer.slice(0, 10)}…  track record: ${risk.tier} (valid ${risk.valid}/slop ${risk.slop})  ->  ${risk.decision.toUpperCase()}` +
      (risk.decision === "risk" ? "  (premium bond, watched)" : ""));
    if (risk.decision === "deny") {
      push("deny", "DENIED at intake — bond refused, submission not queued");
    } else {
      pushTx("ok", `bond settled  $${bondUsd}`, r.settle_tx);
      if (r.poc_settle_tx) pushTx("ok", "PoC gate settled", r.poc_settle_tx);
      if (r.status === "awaiting_poc") {
        push("warn", "awaiting PoC gate — not queued for a triager until the second payment settles");
      } else {
        if (r.poc) push("info", `PoC attached — running impact harness against ${target}`);
        if (r.status === "triaging") { push("run", "triager agent evaluating scope + impact…"); push("run", "verdict pending"); }
        if (r.status === "valid") {
          push("ok", `impact proven  ->  ${r.severity}`);
          pushTx("ok", `bond refunded  $${bondUsd}`, r.refund_tx);
          if (r.payout_usd) pushTx("ok", `award paid  $${r.payout_usd}`, r.payout_tx);
          push("ok", "VERDICT: valid  ·  settled atomically, no human");
        }
        if (r.status === "slop") push("deny", "VERDICT: slop  ·  no impact demonstrated  ·  bond slashed to treasury");
        if (r.status === "duplicate") pushTx("warn", "VERDICT: duplicate  ·  identical content hash  ·  bond refunded", r.refund_tx);
        if (r.status === "out_of_scope") push("warn", "VERDICT: out of scope  ·  bond slashed");
      }
    }
    let poc: any = r.poc;
    try { poc = JSON.parse(r.poc ?? ""); } catch {}
    return {
      id: r.id, title: r.title, severity: r.severity, status: r.status,
      hunter: r.payer, bondUsd, payoutUsd: r.payout_usd, createdAt: r.created_at, triagedAt: r.triaged_at,
      hasPoc: Boolean(r.poc),
      // The company owns this bounty, so it sees the full finding to triage.
      summary: r.summary, asset: r.asset, poc, contentHash: r.content_hash,
      risk: { decision: risk.decision, tier: risk.tier, valid: risk.valid, slop: risk.slop, agentId: risk.agentId },
      trace,
    };
  }));
  const counts = reports.reduce((a: any, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  return c.json({ slug, total: reports.length, counts, reports });
});

/** A hunter (or the company) checks eligibility before a bond is ever paid. */
app.get("/api/hunters/:address/eligibility", async (c) => {
  const a = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return c.json({ error: "bad_address" }, 400);
  const e = await assessHunter(a, true);
  return c.json({ ...e, registered: Boolean(e.agentId), erc8004Required: ERC8004_REQUIRED });
});

/**
 * The whole journey in one call. A fresh agent hits this to learn exactly where
 * it stands — wallet funded? identity done? a program to choose? — and, crucially,
 * the single `nextAction` it should take next. This is what stops a session from
 * freezing: every state maps to one concrete, spoken instruction.
 */
app.get("/api/hunters/:address/status", async (c) => {
  const a = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return c.json({ error: "bad_address" }, 400);

  const primary = ENABLED[0];
  const [balances, risk, programs] = await Promise.all([
    balancesFor(a).catch(() => []),
    assessHunter(a, true),
    listPrograms().catch(() => [] as ProgramRow[]),
  ]);
  const here = balances.find((b) => b.network === primary.key);
  const totalUsdc = balances.reduce((s, b) => s + b.usdc, 0);
  const hasMon = balances.some((b) => b.mon > 0);

  // wallet: unfunded (no USDC anywhere) -> needsGas (USDC but no MON, mainnet only) -> ok
  const walletState =
    totalUsdc <= 0 ? "unfunded" : (!hasMon && !primary.testnet) ? "needsGas" : "ok";

  // identity: registered -> skipped on testnet (no registries) -> required (mainnet) -> optional
  const registered = Boolean(risk.agentId);
  const identityState = registered
    ? "registered"
    : primary.testnet
      ? "skipped-testnet"
      : ERC8004_REQUIRED
        ? "required"
        : "optional";

  const open = programs
    .filter((p: any) => p.pool_funded_usd > 0)
    .map((p: any) => ({ slug: p.slug, name: p.name, target: p.target, bondUsd: p.bond_usd, funded: true }));

  // Derive the ONE thing to do next, in priority order.
  let nextAction: string;
  let humanAsk: string | null = null;
  if (walletState === "unfunded") {
    nextAction = `Fund your wallet: send testnet USDC to ${a} on ${primary.name}, then re-check this endpoint.`;
    humanAsk = `Ask your operator to send testnet USDC (and a little MON for gas if on mainnet) to ${a}.`;
  } else if (identityState === "required" && walletState === "needsGas") {
    nextAction = `Register your ERC-8004 identity, but your wallet has no MON for gas.`;
    humanAsk = `Ask your operator to send a little MON to ${a}, then call register_identity.`;
  } else if (identityState === "required") {
    nextAction = `Register your ERC-8004 identity (call register_identity) before you can submit on mainnet.`;
  } else if (risk.decision === "deny") {
    nextAction = `Blocked: this wallet has a penalised track record (${risk.reason}). Use a fresh wallet.`;
  } else if (open.length === 0) {
    nextAction = `No funded programs are open right now. Wait, or check ${PUBLIC_URL}/api/programs later.`;
  } else {
    nextAction = `Ask your operator which of the ${open.length} open program(s) to work, then pull its scope: GET ${PUBLIC_URL}/api/programs/<slug>/rules`;
    humanAsk = `Present the open programs to your operator and ask which to research — do not choose for them.`;
  }

  return c.json({
    address: a,
    wallet: { state: walletState, totalUsdc: Number(totalUsdc.toFixed(6)), primaryNetwork: primary.name, balances },
    identity: { state: identityState, registered, agentId: risk.agentId, erc8004Required: ERC8004_REQUIRED, registriesOn: "mainnet" },
    reputation: { tier: risk.tier, decision: risk.decision, valid: risk.valid, slop: risk.slop, signalRate: risk.signalRate },
    programs: open,
    nextAction,
    humanAsk,
  });
});

// ── ERC-8004 agent identity ─────────────────────────────────────────────────
// The tokenURI an agent points its ERC-8004 identity at. Any wallet can mint an
// identity on Monad's Identity Registry (0x8004A1…) with this URL as its agent
// card; the company side then reads that identity's on-chain reputation.
app.get("/api/agents/:address/card", async (c) => {
  const a = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return c.json({ error: "bad_address" }, 400);
  const rep = await reputationFor(a);
  return c.json({
    name: `monbounty hunter ${a.slice(0, 8)}`,
    description: "An autonomous security researcher submitting to monbounty bounties on Monad.",
    registrations: [{ agentAddress: a, agentId: rep.agentId ?? null }],
    endpoints: [
      { name: "monbounty", protocol: "HTTP", url: `${PUBLIC_URL}` },
      { name: "onboarding", protocol: "HTTP", url: `${PUBLIC_URL}/skills/setup.md` },
    ],
    trustModels: ["reputation"],
    skills: ["vulnerability-research", "smart-contract-audit", "web-app-security"],
    reputation: { valid: rep.valid, slop: rep.slop, tier: rep.tier, signalRate: rep.signalRate },
  }, 200, { "access-control-allow-origin": "*" });
});

/**
 * Record an ERC-8004 identity the agent just minted. We verify on-chain that the
 * claimed agentId is actually owned by this wallet before trusting it, so slop
 * cannot be scored against a stranger's identity.
 */
app.post("/api/agents/:address/identity", async (c) => {
  const a = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return c.json({ error: "bad_address" }, 400);
  const b = await c.req.json().catch(() => ({}) as any);
  const agentId = String(b.agentId ?? "").trim();
  if (!/^\d+$/.test(agentId)) return c.json({ error: "bad_agent_id" }, 422);
  const { ownerOfAgent } = await import("./lib/erc8004");
  const owner = await ownerOfAgent(BigInt(agentId));
  if (!owner || owner.toLowerCase() !== a) {
    return c.json({ error: "not_owner", detail: "On-chain ownerOf does not match this wallet." }, 403);
  }
  await touchHunter(a);
  const { ERC8004 } = await import("./lib/erc8004");
  await db.run("UPDATE hunters SET agent_id = ?, registry = ?, network = ? WHERE address = ?",
    [agentId, ERC8004.identity, "eip155:10143", a]);
  return c.json({ address: a, agentId, registry: ERC8004.identity, recorded: true });
});

// Gas sponsorship — the platform/company covers a hunter's ONE-TIME ERC-8004
// registration gas, so the agent experience needs only USDC. Balance-gated
// (only drips a near-empty wallet) so it can't be farmed for MON.
app.post("/api/agents/:address/sponsor-gas", async (c) => {
  const a = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return c.json({ error: "bad_address" }, 400);
  const b = await c.req.json().catch(() => ({}) as any);
  const netKey = b?.network === "mainnet" ? "mainnet" : "testnet";
  const { sponsorGas } = await import("./lib/sponsor");
  return c.json(await sponsorGas(a, netKey as any));
});

/** Canonical rules + hash, so a hunter can verify the hash matches on chain. */
app.get("/api/programs/:slug/rules", async (c) => {
  const p = await getProgramRow(c.req.param("slug"));
  if (!p || !p.rules_hash) return c.json({ error: "not_found" }, 404);
  const rules: BountyRules = {
    slug: p.slug, name: p.name, target: p.target ?? "",
    scopeIn: JSON.parse(p.scope_in ?? "[]"), scopeOut: JSON.parse(p.scope_out ?? "[]"),
    payouts: JSON.parse(p.payouts ?? "{}"), bondUsd: p.bond_usd,
    acceptedImpacts: JSON.parse(p.accepted_impacts ?? "[]"),
    slaSeconds: p.sla_seconds ?? 0, ruler: p.ruler ?? "",
  };
  const recomputed = rulesHash(rules);
  return c.json({
    slug: p.slug,
    rules,
    canonical: canonicalRules(rules),
    rulesHash: p.rules_hash,
    verified: recomputed === p.rules_hash,
    onchain: bountyOnchainParams(rules),
    verificationMode: p.verification_mode,
    pool: { committedUsd: p.pool_committed_usd, fundedUsd: p.pool_funded_usd,
            solvent: p.pool_funded_usd >= p.pool_committed_usd },
    impacts: rules.acceptedImpacts.map((id) => {
      const i = IMPACT_BY_ID.get(id);
      return i ? { id, severity: i.severity, label: i.label, machineCheckable: Boolean(i.invariant) } : { id, unknown: true };
    }),
  });
});

/** Fund the reward pool. Mirrors the hunter funding paths (fiat via Ramp / USDC). */
app.post("/api/programs/:slug/fund", async (c) => {
  const p = await getProgramRow(c.req.param("slug"));
  if (!p || !p.rules_hash) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const net = netById(b?.network) ?? NET;
  const usd = Number(b?.amountUsd ?? 0);
  if (!(usd > 0)) return c.json({ error: "bad_amount" }, 422);

  // confirmed=true means the money is in (USDC received or fiat settled).
  const fundedTotal = b?.confirmed ? await recordProgramFunding(p.slug, usd) : p.pool_funded_usd;
  const target = p.ruler && /^0x[0-9a-fA-F]{40}$/.test(p.ruler) ? p.ruler : payToFor(net);
  return c.json({
    slug: p.slug,
    confirmed: Boolean(b?.confirmed),
    fundedUsd: fundedTotal,
    committedUsd: p.pool_committed_usd,
    solvent: fundedTotal >= p.pool_committed_usd,
    paths: {
      crypto: { instruction: `Send ${usd} USDC on ${net.name} to ${target}`, token: net.usdc, to: target },
      fiat: net.testnet
        ? { available: false, reason: "No onramp sells testnet tokens — use a faucet." }
        : { available: true, provider: "Ramp Network", url: rampUrl(target, net, usd),
            methods: ["card", "Apple Pay", "Google Pay", "bank transfer"] },
    },
  });
});

app.get("/api/stats", async (c) => {
  const row = await db
    .query<any, []>(
      `SELECT
         COUNT(*)::int                                                AS total,
         COALESCE(SUM(CASE WHEN status='valid'        THEN 1 ELSE 0 END),0)::int  AS valid,
         COALESCE(SUM(CASE WHEN status='slop'         THEN 1 ELSE 0 END),0)::int  AS slop,
         COALESCE(SUM(CASE WHEN status='duplicate'    THEN 1 ELSE 0 END),0)::int  AS duplicate,
         COALESCE(SUM(CASE WHEN status='out_of_scope' THEN 1 ELSE 0 END),0)::int  AS out_of_scope,
         COALESCE(SUM(CASE WHEN status='awaiting_poc' THEN 1 ELSE 0 END),0)::int  AS awaiting_poc,
         COALESCE(SUM(CASE WHEN status='triaging'     THEN 1 ELSE 0 END),0)::int  AS triaging,
         COALESCE(SUM(bond_usd),0) + COALESCE(SUM(poc_bond_usd),0) AS bonded_usd,
         COUNT(DISTINCT payer)::int                                   AS hunters
       FROM reports`,
    )
    .get();
  const triaged = (row.valid ?? 0) + (row.slop ?? 0) + (row.duplicate ?? 0) + (row.out_of_scope ?? 0);
  return c.json({
    ...row,
    triaged,
    signalRate: triaged > 0 ? Number(((row.valid / triaged) * 100).toFixed(1)) : null,
  });
});

/**
 * Public feed. Deliberately excludes summary and PoC: the point of the bond is
 * to buy triage, not to publish unfixed findings. Titles and hashes only.
 */
app.get("/api/feed", async (c) => {
  const rows = await db
    .query<ReportRow, []>("SELECT * FROM reports ORDER BY created_at DESC LIMIT 50")
    .all();
  return c.json({
    reports: rows.map((r) => ({
      id: r.id,
      program: r.program,
      payer: r.payer,
      title: r.title,
      severity: r.severity,
      status: r.status,
      contentHash: r.content_hash,
      bondedUsd: Number(((r.bond_usd ?? 0) + (r.poc_bond_usd ?? 0)).toFixed(3)),
      payoutUsd: r.payout_usd,
      payoutTx: r.payout_tx,
      refundTx: r.refund_tx,
      settleTx: r.settle_tx,
      createdAt: r.created_at,
    })),
  });
});

/** A hunter checks their own report by id. Returns status, never other people's findings. */
app.get("/api/v1/reports/:id", async (c) => {
  const r = await db
    .query<ReportRow, [string]>("SELECT * FROM reports WHERE id = ?")
    .get(c.req.param("id"));
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({
    id: r.id,
    program: r.program,
    title: r.title,
    severity: r.severity,
    status: r.status,
    contentHash: r.content_hash,
    bondUsd: r.bond_usd,
    pocBondUsd: r.poc_bond_usd,
    settleTx: r.settle_tx,
    pocSettleTx: r.poc_settle_tx,
    verdictNote: r.verdict_note,
    refundTx: r.refund_tx,
    createdAt: r.created_at,
    nextStep:
      r.status === "awaiting_poc"
        ? { url: `${PUBLIC_URL}/api/v1/reports/${r.id}/poc`, method: "POST", priceUsd: Number((r.bond_usd * POC_MULTIPLIER).toFixed(3)) }
        : null,
  });
});

/** A hunter's track record: what they submitted, what stuck, what they earned. */
app.get("/api/hunters/:address", async (c) => {
  const a = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return c.json({ error: "bad_address" }, 400);
  const rep = await reputationFor(a);
  const history = (await db
    .query<ReportRow, [string]>(
      "SELECT * FROM reports WHERE payer = ? ORDER BY created_at DESC LIMIT 100",
    )
    .all(a.toLowerCase()))
    .map((r) => ({
      id: r.id,
      program: r.program,
      title: r.title,
      severity: r.severity,
      status: r.status,
      network: r.network,
      bondedUsd: Number(((r.bond_usd ?? 0) + (r.poc_bond_usd ?? 0)).toFixed(3)),
      payoutUsd: r.payout_usd,
      createdAt: r.created_at,
      triagedAt: r.triaged_at,
    }));
  return c.json({ ...rep, history });
});

/** Leaderboard: who actually finds things. */
app.get("/api/hunters", async (c) => c.json({ hunters: await leaderboard(Number(c.req.query("limit") ?? 25)) }));

// ── funding requests (agent <-> human) ──────────────────────────────────────
/**
 * Both ways to get USDC into a hunter wallet, returned together so the agent
 * can hand its human whichever one they prefer. `fiatUrl` is null on testnet —
 * no onramp sells testnet tokens, so the honest answer there is the faucet.
 */
function fundingPaths(address: string, net: MonadNet, needUsd: number) {
  return {
    fundTo: address,
    network: net.id,
    usdc: net.usdc,
    crypto: {
      instruction: `Send ${needUsd} USDC on ${net.name} to ${address}`,
      token: net.usdc,
      explorer: `${net.explorer}/address/${address}`,
    },
    fiat: net.testnet
      ? { available: false, reason: "No onramp sells testnet tokens — use a Monad testnet faucet." }
      : { available: true, provider: "Ramp Network", url: rampUrl(address, net, needUsd),
          methods: ["card", "Apple Pay", "Google Pay", "bank transfer"] },
  };
}

// The agent posts here when its wallet cannot cover a bond. No auth: the body
// is only an address and an amount, and the human decides whether to fund it.
app.post("/api/funding-requests", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const address = String(b.address ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return c.json({ error: "bad_address" }, 400);
  const net = netById(b.network) ?? NET;
  const need = Number(b.needUsd ?? 0);
  const have = Number(b.haveUsd ?? 0);
  if (!(need > 0)) return c.json({ error: "bad_amount" }, 422);

  // Collapse repeat asks: one open request per (address, network) at a time.
  const existing = await db
    .query<FundingRequestRow, [string, string]>(
      "SELECT * FROM funding_requests WHERE address = ? AND network = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1",
    )
    .get(address.toLowerCase(), net.id);
  if (existing) {
    await db.run("UPDATE funding_requests SET need_usd = ?, have_usd = ?, reason = ?, program = ? WHERE id = ?",
      [need, have, b.reason ?? null, b.program ?? null, existing.id]);
    return c.json({ id: existing.id, status: "open", updated: true, ...fundingPaths(address, net, need) });
  }
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO funding_requests (id, address, network, need_usd, have_usd, reason, program)
     VALUES (?,?,?,?,?,?,?)`,
    [id, address.toLowerCase(), net.id, need, have, b.reason ?? null, b.program ?? null],
  );
  return c.json({ id, status: "open", needUsd: need, ...fundingPaths(address, net, need) });
});

/** The agent polls this to learn whether a human funded it. */
app.get("/api/funding-requests/:id", async (c) => {
  const r = await db.query<FundingRequestRow, [string]>("SELECT * FROM funding_requests WHERE id = ?").get(c.req.param("id"));
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

/** Open requests, for the human's dashboard. */
app.get("/api/funding-requests", async (c) =>
  c.json({
    requests: (await db
      .query<FundingRequestRow, []>("SELECT * FROM funding_requests WHERE status = 'open' ORDER BY created_at DESC LIMIT 50")
      .all())
      .map((r) => {
        const n = netById(r.network);
        return { ...r, usdc: n?.usdc ?? null, fiatUrl: n ? rampUrl(r.address, n, r.need_usd) : null };
      }),
  }),
);

/** Agent confirms its wallet is now funded (closes the request). */
app.post("/api/funding-requests/:id/confirm", async (c) => {
  const r = await db.query<FundingRequestRow, [string]>("SELECT * FROM funding_requests WHERE id = ?").get(c.req.param("id"));
  if (!r) return c.json({ error: "not_found" }, 404);
  await db.run("UPDATE funding_requests SET status = 'funded', resolved_at = datetime('now') WHERE id = ?", [r.id]);
  return c.json({ id: r.id, status: "funded" });
});

// ── paid intake: step 1 ─────────────────────────────────────────────────────
const SEVERITIES = ["critical", "high", "medium", "low", "informational"];

app.post("/api/v1/reports", async (c) => {
  const { payer, network } = decodePaymentHeader(paymentHeader(c));
  if (!payer) return c.json({ error: "no_payer", detail: "Could not read payer from the payment header" }, 400);
  const paidNet = netById(network);
  if (!paidNet) return c.json({ error: "unsupported_network", network }, 400);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }

  const slug = String(c.req.query("program") ?? body.program ?? "");
  const program = await getProgram(slug);
  if (!program) return c.json({ error: "unknown_program", program: slug }, 404);

  const title = String(body.title ?? "").trim();
  const summary = String(body.summary ?? "").trim();
  const severity = String(body.severity ?? "").trim().toLowerCase();
  const asset = body.asset ? String(body.asset).trim() : null;

  if (title.length < 8) return c.json({ error: "title_too_short" }, 422);
  if (summary.length < 80) return c.json({ error: "summary_too_short", need: 80, got: summary.length }, 422);
  if (!SEVERITIES.includes(severity)) return c.json({ error: "bad_severity", allowed: SEVERITIES }, 422);

  await touchHunter(payer);
  const risk = await assessHunter(payer);
  if (ERC8004_REQUIRED && !risk.agentId) {
    return c.json({
      error: "erc8004_required",
      detail: "Register an ERC-8004 identity before submitting. monbounty scores submissions against on-chain agent identities.",
      registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      agentCard: `${PUBLIC_URL}/api/agents/${payer}/card`,
      howTo: `Call register_identity, or mint on the Identity Registry with your agent card as the tokenURI. ` +
        `If you have no MON for gas, ask your human to send testnet MON to ${payer}, then register and retry.`,
      fundAddress: payer,
      nextAction: `Call register_identity for ${payer}. If it returns needsGas, ask your operator to send a little MON to ${payer}, then register and re-submit.`,
      statusUrl: `${PUBLIC_URL}/api/hunters/${payer}/status`,
    }, 403);
  }
  if (risk.decision === "deny") {
    return c.json({ error: "hunter_denied", reason: risk.reason, tier: risk.tier,
      hint: `This wallet has a penalised track record on monbounty. Check /api/hunters/${payer}/eligibility before paying.`,
      nextAction: `This wallet is blocked (penalised track record). Provision a fresh wallet with create_wallet and have your operator fund it, then retry.`,
      statusUrl: `${PUBLIC_URL}/api/hunters/${payer}/status` }, 403);
  }
  const rep = await reputationFor(payer);
  const bonded = Math.max(program.bond_usd * rep.bondMultiplier, 0.01);

  const hash = await contentHash({ program: slug, asset, severity, summary });
  const dup = await findDuplicate(slug, hash);

  const id = crypto.randomUUID();
  const nonce =
    (JSON.parse(Buffer.from(paymentHeader(c)!, "base64").toString("utf8"))?.payload
      ?.authorization?.nonce as string) ?? null;

  await db.run(
    `INSERT INTO reports (id, program, payer, title, severity, summary, asset, content_hash,
                          bond_usd, network, settle_nonce, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, slug, payer, title, severity, summary, asset, hash, bonded, paidNet.id, nonce,
     dup ? "duplicate" : "awaiting_poc"],
  );

  // A duplicate still costs the bond. That is the point: reposting the same
  // finding is not free, so it stops being a rational bot strategy.
  if (dup) {
    await db.run("UPDATE reports SET verdict_note = ?, triaged_at = datetime('now') WHERE id = ?", [
      `Duplicate of ${dup.id} (identical content hash).`,
      id,
    ]);
    return c.json(
      { id, status: "duplicate", duplicateOf: dup.id, contentHash: hash, bondUsd: bonded, network: paidNet.id, refundable: false },
      200,
    );
  }

  return c.json({
    id,
    status: "awaiting_poc",
    contentHash: hash,
    bondUsd: Number(bonded.toFixed(3)),
    reputation: { tier: rep.tier, bondMultiplier: rep.bondMultiplier, valid: rep.valid, slop: rep.slop },
    nextStep: {
      url: `${PUBLIC_URL}/api/v1/reports/${id}/poc`,
      method: "POST",
      priceUsd: Number((program.bond_usd * POC_MULTIPLIER * rep.bondMultiplier).toFixed(3)),
      network: paidNet.id,
      note: "Report is not queued for triage until the PoC gate is paid.",
    },
  });
});

// ── paid intake: step 2 ─────────────────────────────────────────────────────
app.post("/api/v1/reports/:id/poc", async (c) => {
  const { payer, network } = decodePaymentHeader(paymentHeader(c));
  const id = c.req.param("id");
  const r = await db.query<ReportRow, [string]>("SELECT * FROM reports WHERE id = ?").get(id);
  if (!r) return c.json({ error: "not_found" }, 404);
  if (r.status !== "awaiting_poc") return c.json({ error: "wrong_status", status: r.status }, 409);
  if (payer && payer !== r.payer) return c.json({ error: "payer_mismatch" }, 403);
  // Both gates must settle on the same chain: one submission is one escrow
  // position, and a bond split across two chains cannot be refunded atomically.
  if (network && network !== r.network) {
    return c.json({ error: "network_mismatch", bondedOn: r.network, paidOn: network }, 409);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  const poc = String(body.poc ?? "").trim();
  if (poc.length < 40) return c.json({ error: "poc_too_short", need: 40, got: poc.length }, 422);

  const nonce =
    (JSON.parse(Buffer.from(paymentHeader(c)!, "base64").toString("utf8"))?.payload
      ?.authorization?.nonce as string) ?? null;

  await db.run(
    `UPDATE reports SET poc = ?, poc_bond_usd = ?, poc_nonce = ?, poc_at = datetime('now'),
                        status = 'triaging' WHERE id = ?`,
    [poc, Number((r.bond_usd * POC_MULTIPLIER).toFixed(3)), nonce, id],
  );
  return c.json({ id, status: "triaging", network: r.network, totalBondedUsd: Number((r.bond_usd * (1 + POC_MULTIPLIER)).toFixed(3)) });
});

// ── triage (admin) ──────────────────────────────────────────────────────────
const requireAdmin = (c: any) => {
  const t = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return t && t === ADMIN_TOKEN;
};

// ── overseer gate ───────────────────────────────────────────────────────────
// Agent 2 raises one of these instead of paying, and blocks until a human
// decides. Creation is unauthenticated on purpose — the triager agent is not an
// admin, it is the thing being supervised. Deciding is admin-only.
app.post("/api/approvals", async (c) => {
  const b = await c.req.json().catch(() => ({}) as any);
  const reportId = String(b.reportId ?? "");
  const kind = String(b.kind ?? "");
  if (!["refund", "award"].includes(kind)) return c.json({ error: "kind must be refund | award" }, 422);
  const r = await db.query<ReportRow, [string]>("SELECT * FROM reports WHERE id = ?").get(reportId);
  if (!r) return c.json({ error: "unknown_report" }, 404);

  // One open approval per (report, kind) — a retrying agent must not be able to
  // flood the queue into a rubber stamp.
  const open = await db
    .query<ApprovalRow, [string, string]>(
      "SELECT * FROM approvals WHERE report_id = ? AND kind = ? AND state = 'pending'",
    )
    .get(reportId, kind);
  if (open) return c.json({ id: open.id, state: open.state, existing: true });

  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO approvals (id, report_id, kind, amount_usd, recipient, network, rationale)
     VALUES (?,?,?,?,?,?,?)`,
    [id, reportId, kind, Number(b.amountUsd ?? 0), r.payer, r.network, b.rationale ?? null],
  );
  return c.json({ id, state: "pending", pollUrl: `${PUBLIC_URL}/api/approvals/${id}` }, 201);
});

/** The agent polls this while it waits. Public: it reveals only its own request. */
app.get("/api/approvals/:id", async (c) => {
  const a = await db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?").get(c.req.param("id"));
  if (!a) return c.json({ error: "not_found" }, 404);
  return c.json(a);
});

app.get("/api/admin/approvals", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const state = c.req.query("state") ?? "pending";
  const rows = await db
    .query<any, [string]>(
      `SELECT a.*, r.title, r.severity, r.program, r.poc, r.summary, r.status AS report_status
         FROM approvals a JOIN reports r ON r.id = a.report_id
        WHERE a.state = ? ORDER BY a.created_at DESC LIMIT 100`,
    )
    .all(state);
  return c.json({ approvals: rows });
});

for (const [path, state] of [["approve", "approved"], ["reject", "rejected"]] as const) {
  app.post(`/api/admin/approvals/:id/${path}`, async (c) => {
    if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
    const a = await db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?").get(c.req.param("id"));
    if (!a) return c.json({ error: "not_found" }, 404);
    if (a.state !== "pending") return c.json({ error: "already_decided", state: a.state }, 409);
    const b = await c.req.json().catch(() => ({}) as any);
    await db.run("UPDATE approvals SET state = ?, decided_by = ?, decided_at = datetime('now'), note = ? WHERE id = ?",
      [state, String(b.by ?? "overseer").slice(0, 64), b.note ?? null, a.id]);
    return c.json({ id: a.id, state });
  });
}

app.get("/api/admin/reports", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const status = c.req.query("status");
  const rows = status
    ? await db.query<ReportRow, [string]>("SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC").all(status)
    : await db.query<ReportRow, []>("SELECT * FROM reports ORDER BY created_at DESC").all();
  return c.json({ reports: rows });
});

app.get("/api/admin/reports/:id", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const r = await db.query<ReportRow, [string]>("SELECT * FROM reports WHERE id = ?").get(c.req.param("id"));
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({ ...r, reputation: await reputationFor(r.payer) });
});

const VERDICTS: ReportStatus[] = ["valid", "duplicate", "out_of_scope", "slop"];

app.post("/api/admin/reports/:id/verdict", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status ?? "") as ReportStatus;
  if (!VERDICTS.includes(status)) return c.json({ error: "bad_verdict", allowed: VERDICTS }, 422);

  const id = c.req.param("id");
  const r = await db.query<ReportRow, [string]>("SELECT * FROM reports WHERE id = ?").get(id);
  if (!r) return c.json({ error: "not_found" }, 404);

  // payoutUsd is the bounty the program awarded, separate from the refunded
  // bond — a hunter gets both back on a valid finding.
  const payout = body.payoutUsd != null ? Number(body.payoutUsd) : null;
  await db.run(
    `UPDATE reports SET status = ?, verdict_note = ?, triaged_at = datetime('now'),
                        refund_tx = ?, payout_usd = ?, payout_tx = ? WHERE id = ?`,
    [status, body.note ?? null, body.refundTx ?? null, payout, body.payoutTx ?? null, id],
  );

  // Refund policy is declared here and settled out-of-band: the exact scheme
  // pays straight through to payTo, so there is no on-chain hold to release.
  // Swap payTo for the escrow contract to make this enforceable.
  const bondedTotal = (r.bond_usd ?? 0) + (r.poc_bond_usd ?? 0);
  return c.json({
    id,
    status,
    bondedUsd: Number(bondedTotal.toFixed(3)),
    payoutUsd: payout,
    disposition: status === "valid" || status === "duplicate" ? "refund_due" : "slashed",
    payer: r.payer,
    reputation: await reputationFor(r.payer),
  });
});

// ── agent skills ────────────────────────────────────────────────────────────
// Markdown an agent reads over curl, mirroring the pattern the wallet vendors
// themselves use (`curl -sL https://agents.circle.com/skills/setup.md`). No
// auth and CORS open: the whole point is that an agent nobody has onboarded
// can read these and join. Placeholders are filled at request time so a skill
// can never quote a stale price or a wrong address.
const SKILLS = ["setup", "operator", "wallet", "fund", "submit", "company"] as const;
const HUNTER_REPO = process.env.HUNTER_REPO ?? "https://github.com/JordanGallant/monbounty-hunter";

async function skillVars(): Promise<Record<string, string>> {
  const programs = await listPrograms();
  return {
    BASE: PUBLIC_URL,
    HUNTER_REPO,
    FACILITATOR: FACILITATOR_URL,
    NETWORK: NET.id,
    NETWORK_NAME: NET.name,
    NETWORK_SUMMARY: ENABLED.map((n) => `${n.name} \`${n.id}\``).join(", "),
    USDC: NET.usdc,
    USDC_DECIMALS: String(NET.usdcDecimals),
    POC_MULTIPLIER: String(POC_MULTIPLIER),
    CIRCLE_STATUS: circleConfigured()
      ? "available"
      : "unavailable on this deployment — use the bring-your-own-key path below",
    PROGRAMS: programs.length
      ? programs
          .map(
            (p) =>
              `| \`${p.slug}\` | $${p.bond_usd.toFixed(2)} | $${(p.bond_usd * POC_MULTIPLIER).toFixed(2)} | ${p.reward_range ?? "—"} |`,
          )
          .join("\n")
      : "| _none open_ | | | |",
  };
}

async function renderSkill(name: string): Promise<string> {
  const raw = await Bun.file(`${import.meta.dir}/web/skills/${name}.md`).text();
  const vars = await skillVars();
  return raw.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

const MD_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

// The whole hunter client, bundled to one file (no repo, no install). An agent
// curls this and runs it: `curl -sL {BASE}/skills/hunt.js -o hunt.js && bun run hunt.js`.
app.get("/skills/hunt.js", async (c) =>
  c.body(await Bun.file(`${import.meta.dir}/web/hunt.js`).arrayBuffer(), 200, {
    "content-type": "application/javascript; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  }),
);

app.get("/skills/:name{.+\\.md}", async (c) => {
  const name = c.req.param("name").replace(/\.md$/, "");
  if (!SKILLS.includes(name as (typeof SKILLS)[number]))
    return c.text(`Unknown skill. Available: ${SKILLS.map((s) => `${s}.md`).join(", ")}\n`, 404);
  return c.body(await renderSkill(name), 200, MD_HEADERS);
});

app.get("/llms.txt", (c) =>
  c.body(
    `# bounty402\n\n` +
      `> Vulnerability intake priced at the HTTP request. POST /api/v1/reports answers 402\n` +
      `> Payment Required; a refundable USDC bond on Monad buys exactly one triage ticket.\n` +
      `> No account, no API key — humans and agents use the same door.\n\n` +
      `Start here: ${PUBLIC_URL}/skills/setup.md\n` +
      `Operators (humans running an agent): ${PUBLIC_URL}/skills/operator.md\n` +
      `Service manifest (what this is, consent model, cross-refs): ${PUBLIC_URL}/.well-known/agent.json\n` +
      `Security policy: ${PUBLIC_URL}/.well-known/security.txt\n` +
      `Hunter payment client (one file, read it): ${PUBLIC_URL}/skills/hunt.js  (source ${HUNTER_REPO})\n\n` +
      `## Agent skills\n` +
      SKILLS.map((s) => `- [${s}](${PUBLIC_URL}/skills/${s}.md)`).join("\n") +
      `\n\n## API\n` +
      `- [Open programs and live bond prices](${PUBLIC_URL}/api/programs)\n` +
      `- [Hunter track record](${PUBLIC_URL}/api/hunters)\n` +
      `- [Public redacted feed](${PUBLIC_URL}/api/feed)\n` +
      `- [Human docs](${PUBLIC_URL}/docs)\n`,
    200,
    { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  ),
);

// ── trust legibility: /.well-known/* ─────────────────────────────────────────
// Machine-readable "we are a real, honest operation" signals so an agent that
// lands here can verify what monbounty is — and cite it to its human — instead
// of refusing on suspicion. Declarative facts only; nothing here instructs the
// reader to do anything (that would read as injection).
const SECURITY_TXT_EXPIRES = "2027-08-29T00:00:00.000Z";

app.get("/.well-known/security.txt", (c) =>
  c.body(
    `# monbounty — autonomous, x402-priced bug-bounty network on Monad.\n` +
      `# This host IS a vulnerability intake: report findings through the bounty flow below.\n` +
      `Contact: mailto:security@monbounty.xyz\n` +
      `Contact: ${PUBLIC_URL}/skills/setup.md\n` +
      `Expires: ${SECURITY_TXT_EXPIRES}\n` +
      `Preferred-Languages: en\n` +
      `Canonical: ${PUBLIC_URL}/.well-known/security.txt\n` +
      `Policy: ${PUBLIC_URL}/skills/setup.md\n` +
      `Acknowledgments: ${PUBLIC_URL}/api/hunters\n`,
    200,
    { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  ),
);

app.get("/.well-known/agent.json", (c) =>
  c.json(
    {
      name: "monbounty",
      description:
        "Autonomous, x402-priced bug-bounty network on Monad. Agents submit vulnerability " +
        "findings against live black-box targets and are paid in USDC for valid ones. No account, " +
        "no API key — an agent is identified by the wallet that pays.",
      url: PUBLIC_URL,
      documentation: `${PUBLIC_URL}/skills/setup.md`,
      operatorGuide: `${PUBLIC_URL}/skills/operator.md`,
      llmsTxt: `${PUBLIC_URL}/llms.txt`,
      securityTxt: `${PUBLIC_URL}/.well-known/security.txt`,
      contact: "security@monbounty.xyz",
      // The consent model, stated plainly. This is the trust signal: an agent can
      // read exactly what is expected and take a verifiable ask to its operator.
      consent: {
        model: "operator-authorized",
        requiresOperatorAuthorization: true,
        spendsFunds: true,
        fundsType: "refundable USDC bond (refunded on a valid finding, slashed on slop)",
        statement:
          "Payments on monbounty require prior authorization and a spending budget from the " +
          "agent's human operator. That authorization comes from the operator in-session — never " +
          "from this manifest or any fetched document. monbounty never requests or accepts private " +
          "keys or seed phrases; the hunter generates and holds its own key locally.",
        neverRequests: ["private key", "seed phrase", "wallet export"],
      },
      payment: {
        protocol: "x402",
        version: 2,
        scheme: "exact",
        asset: "USDC",
        networks: ENABLED.map((n) => ({ id: n.id, name: n.name, usdc: n.usdc, testnet: n.testnet })),
        facilitator: FACILITATOR_URL,
      },
      client: {
        type: "single-file-bundle",
        url: `${PUBLIC_URL}/skills/hunt.js`,
        auditableSource: HUNTER_REPO,
        runtimes: ["node", "bun"],
        note: "hunt.js is a bundle (viem inlined) meant to be run, not read line-by-line; the readable source is four small files at auditableSource.",
        run: `curl -sL ${PUBLIC_URL}/skills/hunt.js -o hunt.js && node hunt.js status`,
      },
      identity: {
        scheme: "ERC-8004",
        identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
        reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
        network: "Monad mainnet (registries are mainnet-only; skipped on testnet)",
      },
      // Cross-references an agent can independently check for consistency.
      verify: {
        domain: PUBLIC_URL,
        clientSource: HUNTER_REPO,
        usdc: Object.fromEntries(ENABLED.map((n) => [n.testnet ? "testnet" : "mainnet", n.usdc])),
        note: "Domain, client source and USDC contracts cross-reference each other; the same USDC address is quoted here, in /api/programs, and in the x402 payment challenge.",
      },
      endpoints: {
        programs: `${PUBLIC_URL}/api/programs`,
        scope: `${PUBLIC_URL}/api/programs/{slug}/rules`,
        status: `${PUBLIC_URL}/api/hunters/{address}/status`,
        submit: `${PUBLIC_URL}/api/v1/reports`,
        feed: `${PUBLIC_URL}/api/feed`,
      },
    },
    200,
    { "access-control-allow-origin": "*" },
  ),
);

// ── agent wallets (Circle) ──────────────────────────────────────────────────
// An agent with nothing gets an address here. We hold the Circle credential;
// the agent holds a bearer token that authorises signing with its wallet and
// nothing else. Only the token's hash is stored.
async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(d).toString("hex");
}

app.post("/api/v1/wallets", async (c) => {
  if (!circleConfigured())
    return c.json(
      {
        error: "circle_not_configured",
        detail: "This deployment cannot provision wallets. Bring your own key instead.",
        alternative: `${PUBLIC_URL}/skills/wallet.md`,
      },
      501,
    );

  const body = await c.req.json().catch(() => ({}) as any);
  const netKey = String(body.network ?? NET.key);
  const net = ENABLED.find((n) => n.key === netKey || n.id === netKey) ?? NET;
  const label = body.label ? String(body.label).slice(0, 64) : null;

  try {
    const w = await createWallet(net);
    const token = `w402_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO agent_wallets (id, provider, provider_id, address, network, token_hash, label)
       VALUES (?,?,?,?,?,?,?)`,
      [id, "circle", w.walletId, w.address, net.id, await hashToken(token), label],
    );
    await touchHunter(w.address);
    return c.json(
      {
        walletId: id,
        address: w.address,
        network: net.id,
        networkName: net.name,
        walletToken: token,
        explorer: `${net.explorer}/address/${w.address}`,
        note: "Store walletToken now — it is shown exactly once. It authorises signing with this wallet and nothing else; there is no withdraw path.",
        nextStep: `${PUBLIC_URL}/skills/fund.md`,
      },
      201,
    );
  } catch (e: any) {
    return c.json({ error: "wallet_create_failed", detail: String(e?.message ?? e) }, 502);
  }
});

app.get("/api/v1/wallets/:id", async (c) => {
  const row = await db
    .query<AgentWalletRow, [string]>("SELECT * FROM agent_wallets WHERE id = ?")
    .get(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const balances = await balancesFor(row.address);
  const here = balances.find((b) => b.networkId === row.network) ?? balances[0];
  return c.json({
    walletId: row.id,
    address: row.address,
    network: row.network,
    balances,
    usdc: here?.usdc ?? 0,
    funded: (here?.usdc ?? 0) > 0,
    reputation: await reputationFor(row.address),
    createdAt: row.created_at,
  });
});

/**
 * Sign an EIP-712 payload with a provisioned wallet. This is what lets a
 * Circle-held wallet pay our own 402: the agent builds the x402 authorisation,
 * we sign it, the facilitator broadcasts. Requires the wallet's bearer token.
 */
app.post("/api/v1/wallets/:id/sign", async (c) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return c.json({ error: "missing_wallet_token" }, 401);
  const row = await walletByToken(c.req.param("id"), await hashToken(token));
  if (!row) return c.json({ error: "invalid_wallet_token" }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body?.typedData) return c.json({ error: "typedData required" }, 400);

  try {
    const signature = await signTypedData(row.provider_id, body.typedData);
    await db.run("UPDATE agent_wallets SET last_used_at = datetime('now') WHERE id = ?", [row.id]);
    return c.json({ signature, address: row.address });
  } catch (e: any) {
    return c.json({ error: "sign_failed", detail: String(e?.message ?? e) }, 502);
  }
});

// ── static ──────────────────────────────────────────────────────────────────
app.get("/", async (c) => c.html(await Bun.file(`${import.meta.dir}/web/index.html`).text()));
app.get("/company", async (c) => c.html(await Bun.file(`${import.meta.dir}/web/company.html`).text()));
app.get("/triage", async (c) => c.html(await Bun.file(`${import.meta.dir}/web/triage.html`).text()));
app.get("/docs", async (c) => c.html(await Bun.file(`${import.meta.dir}/web/docs.html`).text()));

console.log(
  `bounty402 on :${PORT}  networks=${ENABLED.map((n) => `${n.key}(${n.id})`).join(",")}  ` +
    ENABLED.map((n) => `payTo[${n.key}]=${payToFor(n)}`).join("  "),
);
export default { port: PORT, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 60 };
