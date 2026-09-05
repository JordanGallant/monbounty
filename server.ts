import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

import { NET, ENABLED, netById, payToFor, rampUrl, offrampUrl, FACILITATOR_URL, PORT, PUBLIC_URL, ADMIN_TOKEN, DEFAULT_BOND_USD, POC_MULTIPLIER, ERC8004_REQUIRED, usdPrice, assertConfig, CUSTODY_ENABLED, stripeConfigured, stripeWebhookReady, STRIPE_PUBLISHABLE_KEY, PLATFORM_DEPOSIT_ADDRESS, type MonadNet } from "./lib/config";
import { db, getProgram, listPrograms, findDuplicate, walletByToken, getProgramRow, createBountyProgram, recordProgramFunding, listAllPrograms, setProgramApproval, setProgramRecipe, createDeposit, getDeposit, getDepositByProvider, markDepositCredited, createWithdrawal, markWithdrawal, listWithdrawals, listDeposits, type ReportRow, type ReportStatus, type FundingRequestRow, type AgentWalletRow, type ApprovalRow, type ProgramRow } from "./lib/db";
import { toAtomic, fromAtomic, balanceAtomic, balanceUsd, history as ledgerHistory, creditDeposit, moveUserToProgram, debitWithdrawal, integrity, userRef, externalRef, post as ledgerPost } from "./lib/ledger";
import { createCheckoutSession, verifyWebhook, createRefund } from "./lib/stripe";
import { setDepositPaymentIntent, listRefundableStripeDeposits, addDepositRefunded } from "./lib/db";
import { fiatToUsdc } from "./lib/conversion";
import { startDepositWatcher } from "./lib/deposit-watch";
import { treasuryFromEnv } from "./agent/treasury";
import { createAccount, getAccount, issueCredential, resolveApiKey, verifyRecovery, revokeApiKeys, rotateRecovery, setBoundWithdrawAddress, accountRef, type AccountKind } from "./lib/accounts";
import { getAgentWallet, addWalletSpend } from "./lib/db";
import { assertBondAuthorization } from "./lib/x402-guard";
import { canonicalRules, rulesHash, bountyOnchainParams, validateRules, type BountyRules } from "./lib/rules";
import { swarmUpload, swarmVerify, bzzUrl, bzzUri, SWARM_ENABLED, SWARM_GATEWAY } from "./lib/swarm";
import { encodeSwarmContenthash, setContenthashPlan, readEnsSwarm, programEnsName, isPlainSwarmRef, MONBOUNTY_ENS_PARENT } from "./lib/ens";
import { setProgramSwarm, setReportSwarm } from "./lib/db";
import { initSvm, svmPrice, SOLANA_DEVNET_CAIP2 } from "./lib/x402-svm";
import { isSolanaAddress, solExplorer, SOLANA_USDC } from "./lib/solana";
import { SEVERITIES, IMPACT_BY_ID, IMPACTS, machineCheckable, validatePayouts, PRESET_PAYOUTS, criticalFromTvl, type PayoutTable } from "./lib/severity";
import { decodePaymentHeader, contentHash } from "./lib/payment";
import { reputationFor, leaderboard, touchHunter, assessHunter } from "./lib/reputation";
import { circleConfigured, createWallet, createSolanaWallet as circleCreateSolanaWallet, signTypedData } from "./lib/circle";
import { balancesFor } from "./lib/balance";

assertConfig();

const paymentHeader = (c: any): string | undefined =>
  c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("payment-signature") ?? c.req.header("X-PAYMENT") ?? undefined;

const app = new Hono();

// ── x402 resource server ────────────────────────────────────────────────────
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
// Solana devnet x402: an in-process facilitator (lib/x402-svm.ts). Null when
// SOLANA_ENABLED != 1 or init fails — the EVM flow is never affected.
const svm = await initSvm();
const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO ?? svm?.feePayer ?? "";
const resourceServer = new x402ResourceServer(svm ? [facilitator, svm.facilitator] : facilitator);
// One scheme instance per network. The client decides which of the advertised
// `accepts` entries to pay, so mainnet, testnet and Solana coexist on one route.
for (const net of ENABLED) resourceServer.register(net.id, new ExactEvmScheme());
if (svm) resourceServer.register(SOLANA_DEVNET_CAIP2, svm.serverScheme);

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

/** Bond for step 1 in USD, from the program named in ?program=. */
const submitBondUsd = async (ctx: any): Promise<number> => {
  const slug = String(ctx?.adapter?.getQueryParam?.("program") ?? "");
  const program = slug ? await getProgram(slug) : null;
  return bondFor(program?.bond_usd ?? DEFAULT_BOND_USD, ctx);
};

/** Step 2 bond in USD — a multiple of step 1. This is the gate bots die on. */
const pocBondUsd = async (ctx: any): Promise<number> => {
  const id = String(ctx?.path ?? "").split("/").at(-2) ?? "";
  const row = await db
    .query<{ bond_usd: number }, [string]>("SELECT bond_usd FROM reports WHERE id = ?")
    .get(id);
  const base = row?.bond_usd ?? DEFAULT_BOND_USD;
  return bondFor(base * POC_MULTIPLIER, ctx);
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

/**
 * Build the x402 `accepts` list for a route: one EVM entry per enabled Monad
 * network, plus a Solana devnet entry when the SVM rail is up. The same USD bond
 * is quoted on every chain — the payer picks which one to settle on. EVM prices
 * wrap the USD in EIP-3009 USDC; Solana wraps it in the SPL USDC mint amount.
 */
const acceptsFor = (
  bondUsd: (ctx: any) => Promise<number>,
  evmPayTo: (n: MonadNet) => (ctx: any) => string | Promise<string>,
) => {
  const entries: any[] = ENABLED.map((net) => ({
    scheme: "exact" as const,
    network: net.id,
    payTo: evmPayTo(net),
    price: async (ctx: any) => usdPrice(await bondUsd(ctx), net),
  }));
  if (svm && SOLANA_PAY_TO) {
    entries.push({
      scheme: "exact" as const,
      network: SOLANA_DEVNET_CAIP2,
      payTo: SOLANA_PAY_TO,
      price: async (ctx: any) => svmPrice(await bondUsd(ctx)),
    });
  }
  return entries;
};

app.use(
  paymentMiddleware(
    {
      "POST /api/v1/reports": {
        accepts: acceptsFor(submitBondUsd, submitPayTo),
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
        accepts: acceptsFor(pocBondUsd, pocPayTo),
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

/**
 * Create a fresh EVM hunter wallet. Default: a Circle developer-controlled
 * wallet — the key is HSM-held, the agent never touches a private key and signs
 * x402 bonds through Circle. Pass ?custody=local to get a self-custody keypair
 * (fallback when Circle is unconfigured).
 */
app.post("/api/wallet", async (c) => {
  const local = c.req.query("custody") === "local";
  if (!local && circleConfigured()) {
    try {
      const w = await createWallet(NET);
      return c.json({
        address: w.address, walletId: w.walletId, custody: "circle", chain: w.chain,
        networks: ENABLED.map((n) => ({ id: n.id, name: n.name, usdc: n.usdc, testnet: n.testnet })),
        identity: { scheme: "evm-address", id: w.address,
          note: "Circle developer-controlled wallet — the private key is HSM-held; you sign x402 bonds via Circle and never manage a key." },
        fund: { usdc: `Deposit USDC to ${w.address} on ${ENABLED.map((n) => n.name).join(" or ")}.` },
        statusUrl: `${PUBLIC_URL}/api/hunters/${w.address}/status`,
      });
    } catch (e) {
      console.warn("[circle] EVM wallet create failed, falling back to local:", String(e).slice(0, 160));
    }
  }
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return c.json({
    address, privateKey, custody: "local",
    networks: ENABLED.map((n) => ({ id: n.id, name: n.name, usdc: n.usdc, testnet: n.testnet })),
    identity: { scheme: "evm-address", id: address,
      note: "Self-custody keypair — fund with USDC only; the facilitator pays gas." },
    fund: { usdc: `Deposit USDC to ${address} on ${ENABLED.map((n) => n.name).join(" or ")}.` },
    statusUrl: `${PUBLIC_URL}/api/hunters/${address}/status`,
    keep: "Store privateKey securely. monbounty does not keep it.",
  });
});

// ── Solana devnet rail: wallet creation, identity, balances ──────────────────
// Parity with the EVM side. A hunter or company provisions a Solana wallet, is
// identified by its pubkey, and funds it with devnet USDC to pay bonds over the
// Solana x402 gate (advertised in the 402 challenge alongside Monad).

/**
 * Create a fresh Solana wallet. Default: a Circle developer-controlled wallet
 * (HSM-held key, agent never manages it). Pass ?custody=local for a self-custody
 * keypair (fallback when Circle is unconfigured).
 */
app.post("/api/solana/wallet", async (c) => {
  if (!svm) return c.json({ error: "solana_disabled" }, 404);
  const local = c.req.query("custody") === "local";
  if (!local && circleConfigured()) {
    try {
      const w = await circleCreateSolanaWallet(true);
      return c.json({
        address: w.address, walletId: w.walletId, custody: "circle", network: SOLANA_DEVNET_CAIP2,
        identity: { scheme: "solana-pubkey", id: w.address,
          note: "Circle developer-controlled Solana wallet — the key is HSM-held; the agent signs via Circle and never manages a key." },
        fund: { usdc: `Devnet USDC (${SOLANA_USDC}) via https://faucet.circle.com` },
        explorer: solExplorer("address", w.address),
      });
    } catch (e) {
      console.warn("[circle] Solana wallet create failed, falling back to local:", String(e).slice(0, 160));
    }
  }
  const { createSolanaWallet } = await import("./lib/solana");
  const w = createSolanaWallet();
  return c.json({
    address: w.address,
    secretKeyBase58: w.secretKeyBase58,
    custody: "local",
    network: SOLANA_DEVNET_CAIP2,
    identity: { scheme: "solana-pubkey", id: w.address,
      note: "Self-custody keypair — your pubkey IS your identity, no registry needed." },
    fund: {
      sol: "Devnet SOL for tx fees: https://faucet.solana.com (paste the address)",
      usdc: `Devnet USDC (${(await import("./lib/solana")).SOLANA_USDC}) via https://faucet.circle.com`,
    },
    explorer: solExplorer("address", w.address),
    keep: "Store secretKeyBase58 securely. monbounty does not keep it.",
  });
});

/** Wallet + identity status for a Solana address — mirrors the EVM hunter status. */
app.get("/api/solana/:address/status", async (c) => {
  if (!svm) return c.json({ error: "solana_disabled" }, 404);
  const address = c.req.param("address");
  if (!isSolanaAddress(address)) return c.json({ error: "bad_address" }, 422);
  const { solanaBalances, SOLANA_USDC } = await import("./lib/solana");
  const bal = await solanaBalances(address);
  const nextAction = bal.needsGas
    ? "Fund with devnet SOL (tx fees) at https://faucet.solana.com, then devnet USDC at https://faucet.circle.com."
    : !bal.funded
      ? `Fund with devnet USDC (${SOLANA_USDC}) at https://faucet.circle.com to pay a bond.`
      : "Funded. Submit a report — the x402 challenge offers a Solana devnet payment option.";
  return c.json({
    address, network: SOLANA_DEVNET_CAIP2,
    identity: { scheme: "solana-pubkey", id: address },
    balances: { sol: bal.sol, usdc: bal.usdc },
    ready: bal.funded, needsGas: bal.needsGas,
    payment: { asset: SOLANA_USDC, payTo: SOLANA_PAY_TO, feePayer: svm.feePayer },
    nextAction, explorer: solExplorer("address", address),
  });
});

// ── web3 intake: submit a contract address (verify it's deployed) or an ABI ──
// A company opening an on-chain bounty submits either a deployed contract
// address — which we verify actually has bytecode on the target chain — or a
// raw ABI. The verified target then scopes an onchain-fork PoC bounty
// (contracts/poc/ImpactProof harness proves the impact band).
app.post("/api/web3/verify-contract", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const address = String(body.address ?? "").trim();
  const rpcUrl = String(body.rpc ?? process.env.WEB3_DEMO_RPC ?? "http://127.0.0.1:8545");
  const abi = body.abi ?? null;

  // ABI-only submission: accept it, no chain lookup needed.
  if (!address && abi) {
    return c.json({ mode: "abi", accepted: true,
      functions: Array.isArray(abi) ? abi.filter((x: any) => x?.type === "function").map((x: any) => x.name) : null });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return c.json({ error: "bad_address" }, 422);

  try {
    const { createPublicClient, http } = await import("viem");
    const client = createPublicClient({ transport: http(rpcUrl) });
    const [code, chainId] = await Promise.all([
      client.getBytecode({ address: address as `0x${string}` }),
      client.getChainId().catch(() => null),
    ]);
    const deployed = Boolean(code && code !== "0x");
    return c.json({
      mode: "address", address, rpc: rpcUrl, chainId,
      deployed, codeSizeBytes: deployed ? (code!.length - 2) / 2 : 0,
      abi: abi ?? undefined,
      verdict: deployed
        ? "Contract is deployed — eligible to scope an onchain-fork bounty."
        : "No bytecode at this address on the given RPC (not deployed / wrong chain).",
    });
  } catch (e) {
    return c.json({ error: "rpc_error", detail: String(e).slice(0, 160), rpc: rpcUrl }, 502);
  }
});

// ── public read API ─────────────────────────────────────────────────────────
app.get("/healthz", (c) =>
  c.json({ ok: true, networks: ENABLED.map((n) => n.id), facilitator: FACILITATOR_URL }),
);

/**
 * The Swarm + ENS storage anchors for a program, for API responses. `swarm` is
 * where the canonical rules live (content-addressed, censorship-resistant);
 * `ens` is the human-readable name whose contenthash points at that Swarm ref.
 */
function storageBlock(p: ProgramRow) {
  const ref = p.rules_swarm_ref;
  const name = p.ens_name ?? programEnsName(p.slug);
  return {
    swarm: ref
      ? { reference: ref, uri: bzzUri(ref), url: bzzUrl(ref), gateway: SWARM_GATEWAY }
      : null,
    ens: {
      name,
      // The contenthash a name owner sets so `name.eth` resolves to the rules.
      contenthash: ref && isPlainSwarmRef(ref) ? encodeSwarmContenthash(ref) : null,
      dweb: `https://${name}.limo`,
    },
  };
}

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
    solana: svm
      ? { network: SOLANA_DEVNET_CAIP2, usdc: process.env.SOLANA_USDC ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          payTo: SOLANA_PAY_TO, feePayer: svm.feePayer, facilitator: "in-process",
          createWallet: `${PUBLIC_URL}/api/solana/wallet` }
      : null,
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
        storage: storageBlock(p),
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
    // Deployment profile (optional): names the production surface so verdicts
    // can flag when the sandbox can't reproduce it (e.g. Vercel). Normalised so
    // an unknown platform string doesn't leak straight through.
    if (b.deployment && typeof b.deployment === "object") {
      const { normalizePlatform } = await import("./lib/deployment-context");
      const d = b.deployment;
      recipe.deployment = {
        platform: normalizePlatform(d.platform),
        framework: d.framework ? String(d.framework) : undefined,
        frameworkVersion: d.frameworkVersion ? String(d.frameworkVersion) : undefined,
        runtime: d.runtime ? String(d.runtime) : undefined,
        waf: typeof d.waf === "boolean" ? d.waf : undefined,
        notes: d.notes ? String(d.notes) : undefined,
      };
    }
  } else if (b?.web3 && typeof b.web3 === "object") {
    // onchain-fork mode: capture the web3 target (chain / VM / how the source is
    // provided) so the fork-and-PoC harness knows what to reproduce, and the
    // committed scope reflects the VM. Normalised via lib/chain-context.
    const { normalizeEcosystem, ecosystemFromLang } = await import("./lib/chain-context");
    const w = b.web3;
    const language = String(w.language ?? "solidity").toLowerCase();
    const ecosystem = w.ecosystem ? normalizeEcosystem(w.ecosystem) : ecosystemFromLang(language as any);
    const sourceMode = ["verified-onchain", "abi-only", "repo"].includes(w.sourceMode) ? w.sourceMode : "verified-onchain";
    recipe = {
      web3: {
        ecosystem, language, sourceMode,
        network: w.network ? String(w.network) : undefined,
        forkBlock: w.forkBlock != null ? Number(w.forkBlock) : undefined,
        repo: w.repo ? String(w.repo).trim() : undefined,
        contracts: Array.isArray(w.contracts) ? w.contracts.map((x: any) => ({
          address: x.address ? String(x.address) : undefined,
          name: x.name ? String(x.name) : undefined,
          verified: typeof x.verified === "boolean" ? x.verified : undefined,
          abiProvided: typeof x.abiProvided === "boolean" ? x.abiProvided : undefined,
        })) : [],
        notes: w.notes ? String(w.notes) : undefined,
      },
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
  if (!pocInput && report.poc) { try { pocInput = JSON.parse(report.poc); } catch { pocInput = { poc: report.poc }; } } // prose PoC -> keep raw text for path extraction
  // Agents often write a PoC as prose / curl steps ({ steps:[...], notes }) rather
  // than { impact, requests[] }. Coerce any recognisable request paths out of it so
  // a real finding isn't rejected on formatting alone.
  if (pocInput && !Array.isArray(pocInput.requests)) {
    const blob = Array.isArray(pocInput.steps) ? pocInput.steps.join("\n")
      : typeof pocInput.poc === "string" ? pocInput.poc : JSON.stringify(pocInput ?? {});
    const paths = new Set();
    for (const m of blob.matchAll(/https?:\/\/[^\s"'`]+/g)) { try { const u = new URL(m[0]); paths.add(u.pathname + (u.search || "")); } catch {} }
    for (const m of blob.matchAll(/(?<![\w:])\/api\/[A-Za-z0-9_\-\/.%?=&]*/g)) paths.add(m[0]);
    const list = [...paths].filter((p) => p && p !== "/");
    if (list.length) pocInput.requests = list.map((p) => ({ path: p, method: "GET" }));
  }
  if (pocInput && !pocInput.impact) pocInput.impact = "web-idor";
  if (!pocInput?.requests || !pocInput?.impact)
    return c.json({ error: "no_structured_poc", hint: "Provide poc: { impact, requests[] } or steps with request paths." }, 422);

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

  // Publish the evidence bundle (transcript + evidence hash) to Swarm so the
  // machine verdict is permanently auditable — the "responsible AI" guarantee:
  // an AI graded this, and here is the exact, immutable evidence anyone can check.
  let evidenceSwarmRef: string | null = null;
  if (SWARM_ENABLED) {
    try {
      const bundle = JSON.stringify({
        kind: "monbounty.evidence", version: 1,
        reportId: report.id, program: prog.slug, impact: pocInput.impact,
        proven: result.proven, assertionMatched: result.assertionMatched,
        surface: result.surface ?? null, representative: result.representative ?? null,
        evidenceHash: result.evidenceHash, transcript: result.transcript, log: result.log,
        verifiedAt: new Date().toISOString(),
      });
      // ENCRYPTED — the transcript replays the exploit, so it's as sensitive as
      // the PoC itself. The reference embeds the key; only ref-holders can read it.
      const up = await swarmUpload(bundle, { encrypt: true, filename: `${report.id}.evidence.json`, contentType: "application/json" });
      evidenceSwarmRef = up.reference;
      await setReportSwarm(report.id, "evidence", evidenceSwarmRef);
    } catch (e) {
      console.warn(`[swarm] evidence publish failed for ${report.id}:`, String(e).slice(0, 160));
    }
  }

  // Determine severity from the proven impact.
  const impact = IMPACT_BY_ID.get(pocInput.impact);
  const verdict = result.proven ? "valid" : "unproven";
  return c.json({
    evidenceSwarm: evidenceSwarmRef ? { reference: evidenceSwarmRef, url: bzzUrl(evidenceSwarmRef) } : null,
    reportId: report.id, program: prog.slug, verificationMode: "company-attested",
    verdict, proven: result.proven, impact: pocInput.impact,
    severity: result.proven ? impact?.severity ?? null : null,
    // What the PoC was replayed against. When representative is false the
    // sandbox couldn't reproduce the declared production platform, so a proven
    // result is "reproduced here" not "exploitable in prod" — the ruler
    // confirms against production before settling.
    surface: result.surface ?? null,
    representative: result.representative ?? null,
    evidenceHash: result.evidenceHash, transcript: result.transcript, log: result.log,
    note: !result.proven
      ? "PoC did not satisfy the committed impact assertion against the forked deploy."
      : result.representative === false
        ? `Impact reproduced in the sandbox, but against ${result.surface} — this does NOT faithfully represent the ` +
          "declared production platform. Confirm the exploit against the real deployment before signing/settling."
        : `Impact proven by executing the PoC against a fresh fork of the company's repo (${result.surface}). ` +
          "Sign this verdict + evidence hash and settle.",
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
  // The raw finding + PoC is the sensitive part of a bounty submission — only the
  // program's own team (admin) sees it; the public feed shows the outcome trace.
  const isAdmin = requireAdmin(c);
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
      network: r.network, hasPoc: Boolean(r.poc),
      // Full finding (summary + exploit PoC) is admin-only; redacted for the public feed.
      ...(isAdmin ? { summary: r.summary, asset: r.asset, poc } : {}),
      contentHash: r.content_hash,
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
    storage: storageBlock(p),
    verificationMode: p.verification_mode,
    pool: { committedUsd: p.pool_committed_usd, fundedUsd: p.pool_funded_usd,
            solvent: p.pool_funded_usd >= p.pool_committed_usd },
    impacts: rules.acceptedImpacts.map((id) => {
      const i = IMPACT_BY_ID.get(id);
      return i ? { id, severity: i.severity, label: i.label, machineCheckable: Boolean(i.invariant) } : { id, unknown: true };
    }),
  });
});

/**
 * The three-way integrity proof for a program, computed LIVE:
 *   1. on-chain rulesHash (committed in SubmissionRegistry at createBounty)
 *   2. Swarm: fetch the rules back from the public gateway, keccak256 the bytes
 *   3. ENS: read the name's contenthash from mainnet and decode its Swarm ref
 * If all three agree, the rules a hunter reads are provably the exact ones the
 * company is bound to — and no party can quietly alter them after publication.
 */
app.get("/api/programs/:slug/proof", async (c) => {
  const p = await getProgramRow(c.req.param("slug"));
  if (!p || !p.rules_hash) return c.json({ error: "not_found" }, 404);

  const swarm: any = { reference: p.rules_swarm_ref, ok: false };
  if (p.rules_swarm_ref) {
    try {
      const v = await swarmVerify(p.rules_swarm_ref, p.rules_hash);
      swarm.ok = v.ok;
      swarm.retrievedHash = v.retrievedHash;
      swarm.bytes = v.bytes;
      swarm.url = bzzUrl(p.rules_swarm_ref);
    } catch (e) {
      swarm.error = String(e).slice(0, 160);
    }
  }

  const ensName = p.ens_name ?? programEnsName(p.slug);
  const ens: any = {
    name: ensName,
    expectedContenthash: p.rules_swarm_ref && isPlainSwarmRef(p.rules_swarm_ref)
      ? encodeSwarmContenthash(p.rules_swarm_ref) : null,
    resolves: false,
  };
  if (c.req.query("ens") === "1") {
    try {
      const r = await readEnsSwarm(ensName);
      ens.resolver = r.resolver;
      ens.onchainContenthash = r.contenthash;
      ens.onchainSwarmRef = r.swarmRef;
      ens.resolves = Boolean(r.swarmRef) && r.swarmRef === p.rules_swarm_ref;
    } catch (e) {
      ens.error = String(e).slice(0, 160);
    }
  }

  return c.json({
    slug: p.slug,
    onchain: { rulesHash: p.rules_hash },
    swarm,
    ens,
    // The core claim: the committed hash equals what Swarm serves. (ENS match is
    // only asserted when ?ens=1 forces a live mainnet read.)
    allMatch: swarm.ok && (c.req.query("ens") !== "1" || ens.resolves),
  });
});

/**
 * The exact transaction a name owner signs to point their ENS name at this
 * program's Swarm-stored rules. monbounty never holds the name's key — it just
 * produces the calldata; the human sends it from their own wallet.
 */
app.get("/api/programs/:slug/ens-plan", async (c) => {
  const p = await getProgramRow(c.req.param("slug"));
  if (!p || !p.rules_hash) return c.json({ error: "not_found" }, 404);
  if (!p.rules_swarm_ref || !isPlainSwarmRef(p.rules_swarm_ref)) {
    return c.json({ error: "no_swarm_ref", hint: "publish rules to Swarm first" }, 409);
  }
  const name = c.req.query("name") ?? p.ens_name ?? programEnsName(p.slug);
  const plan = setContenthashPlan(name, p.rules_swarm_ref);
  return c.json({
    ...plan,
    resolverHint: "Send `calldata` to the name's ENS resolver (Public Resolver setContenthash).",
    dweb: `https://${name}.limo`,
  });
});

/** (Re)publish a program's canonical rules to Swarm and record the reference. */
app.post("/api/programs/:slug/republish-swarm", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const p = await getProgramRow(c.req.param("slug"));
  if (!p || !p.rules_hash) return c.json({ error: "not_found" }, 404);
  const rules: BountyRules = {
    slug: p.slug, name: p.name, target: p.target ?? "",
    scopeIn: JSON.parse(p.scope_in ?? "[]"), scopeOut: JSON.parse(p.scope_out ?? "[]"),
    payouts: JSON.parse(p.payouts ?? "{}"), bondUsd: p.bond_usd,
    acceptedImpacts: JSON.parse(p.accepted_impacts ?? "[]"),
    slaSeconds: p.sla_seconds ?? 0, ruler: p.ruler ?? "",
  };
  const up = await swarmUpload(canonicalRules(rules), {
    filename: `${p.slug}.rules.json`, contentType: "application/json",
  });
  const ensName = p.ens_name ?? programEnsName(p.slug);
  await setProgramSwarm(p.slug, up.reference, ensName);
  const matchesOnchain = up.contentHash.toLowerCase() === p.rules_hash.toLowerCase();
  return c.json({ slug: p.slug, swarm: { reference: up.reference, url: up.url, bytes: up.bytes },
    ensName, contentHash: up.contentHash, rulesHash: p.rules_hash, matchesOnchain });
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
  const dec = decodePaymentHeader(paymentHeader(c));
  // Solana (SVM) payments carry a signed transaction, not an EIP-3009
  // authorization, so the payer isn't in the header. The payment is already
  // verified + settled by the facilitator before this handler runs; the client
  // labels it with ?chain=solana&payer=<address> so we record who paid.
  const isSvm = c.req.query("chain") === "solana";
  let payer = dec.payer;
  let paidNet: any;
  if (isSvm) {
    payer = c.req.query("payer") ?? null;
    if (!payer || !isSolanaAddress(payer))
      return c.json({ error: "no_payer", detail: "Pass ?payer=<solana address> for a Solana payment" }, 400);
    paidNet = { id: "solana-devnet", name: "Solana Devnet", key: "solana", testnet: true };
  } else {
    if (!payer) return c.json({ error: "no_payer", detail: "Could not read payer from the payment header" }, 400);
    paidNet = netById(dec.network);
    if (!paidNet) return c.json({ error: "unsupported_network", network: dec.network }, 400);
  }

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
  const dec = decodePaymentHeader(paymentHeader(c));
  const isSvm = c.req.query("chain") === "solana";
  const payer = isSvm ? (c.req.query("payer") ?? null) : dec.payer;
  const network = isSvm ? "solana-devnet" : dec.network;
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

  // Snapshot the complete report (findings + PoC) to Swarm, ENCRYPTED. This is
  // the hunter's censorship-resistant copy: once it's on Swarm the company can't
  // make a valid finding disappear, and the reference is a capability only its
  // holders can decrypt. Non-fatal if Swarm is briefly unreachable.
  let swarmRef: string | null = null;
  if (SWARM_ENABLED) {
    try {
      const doc = JSON.stringify({
        kind: "monbounty.report", version: 1,
        reportId: id, program: r.program, payer: r.payer,
        title: r.title, severity: r.severity, summary: r.summary, asset: r.asset,
        contentHash: r.content_hash, poc, submittedAt: new Date().toISOString(),
      });
      const up = await swarmUpload(doc, { encrypt: true, filename: `${id}.report.json`, contentType: "application/json" });
      swarmRef = up.reference;
      await setReportSwarm(id, "content", swarmRef);
    } catch (e) {
      console.warn(`[swarm] report snapshot failed for ${id}:`, String(e).slice(0, 160));
    }
  }
  return c.json({ id, status: "triaging", network: r.network,
    totalBondedUsd: Number((r.bond_usd * (1 + POC_MULTIPLIER)).toFixed(3)),
    storage: swarmRef ? { swarm: { reference: swarmRef, encrypted: true,
      note: "Your full report is stored encrypted on Swarm; keep this reference as your durable, censorship-resistant copy." } } : null,
  });
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

  // Publish the signed verdict to Swarm — the final, immutable record of what
  // was decided, by whom, and against which evidence. Links the report and
  // evidence artifacts, so the whole submission→verdict trail is auditable.
  let verdictSwarmRef: string | null = null;
  if (SWARM_ENABLED) {
    try {
      // The verdict is the public, auditable record of the outcome — so it holds
      // only HASHES (integrity commitments), never the Swarm references, which are
      // capabilities that embed decryption keys for the report + evidence.
      const doc = JSON.stringify({
        kind: "monbounty.verdict", version: 1,
        reportId: id, program: r.program, status,
        payoutUsd: payout, note: body.note ?? null,
        refundTx: body.refundTx ?? null, payoutTx: body.payoutTx ?? null,
        contentHash: r.content_hash ?? null,
        evidenceHash: body.evidenceHash ?? null,
        ruler: body.ruler ?? null, gradedAt: new Date().toISOString(),
      });
      const up = await swarmUpload(doc, { filename: `${id}.verdict.json`, contentType: "application/json" });
      verdictSwarmRef = up.reference;
      await setReportSwarm(id, "verdict", verdictSwarmRef);
    } catch (e) {
      console.warn(`[swarm] verdict publish failed for ${id}:`, String(e).slice(0, 160));
    }
  }

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
    verdictSwarm: verdictSwarmRef ? { reference: verdictSwarmRef, url: bzzUrl(verdictSwarmRef) } : null,
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

// ── company waitlist (landing "Open a bounty" form) ──────────────────────────
app.post("/api/waitlist", async (c) => {
  let b: any; try { b = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const email = String(b?.email ?? "").trim();
  const company = String(b?.company ?? "").trim();
  const website = b?.website ? String(b.website).trim() : null;
  const message = b?.message ? String(b.message).trim() : null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "bad_email" }, 422);
  if (company.length < 2) return c.json({ error: "company_required" }, 422);
  const id = crypto.randomUUID();
  await db.run("INSERT INTO waitlist (id, company, email, website, message) VALUES (?,?,?,?,?)",
    [id, company, email, website, message]);
  return c.json({ ok: true, id });
});
app.get("/api/admin/waitlist", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const rows = await db.query("SELECT * FROM waitlist ORDER BY created_at DESC").all();
  return c.json({ total: rows.length, entries: rows });
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
  const spendCap = Number.isFinite(Number(body.spendCapUsd)) && Number(body.spendCapUsd) > 0 ? Number(body.spendCapUsd) : null;

  // Link to the caller's account when they authenticate with an account api key
  // (the recommended default: the account is the durable identity, the wallet its
  // signer). Standalone wallets stay allowed for backward-compat.
  let accountId: string | null = null;
  const authTok = bearer(c);
  if (authTok?.startsWith("mb_ak_")) accountId = await resolveApiKey(authTok);

  try {
    const w = await createWallet(net);
    const token = `w402_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO agent_wallets (id, provider, provider_id, address, network, token_hash, label, account_id, spend_cap_usd)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, "circle", w.walletId, w.address, net.id, await hashToken(token), label, accountId, spendCap],
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

  // The choke point: only sign a whitelisted x402 bond to our own intake — never
  // an arbitrary transfer. A stolen walletToken therefore cannot drain the wallet.
  const guard = assertBondAuthorization(body.typedData, { address: row.address, network: row.network });
  if (!guard.ok) return c.json({ error: "payload_not_whitelisted", detail: guard.error }, 403);

  // Per-token spend cap (null = unlimited).
  if (row.spend_cap_usd != null && row.spent_usd + guard.valueUsd > row.spend_cap_usd + 1e-9)
    return c.json({ error: "cap_exceeded", detail: `cap $${row.spend_cap_usd}, spent $${row.spent_usd}, this $${guard.valueUsd}` }, 403);

  try {
    const signature = await signTypedData(row.provider_id, body.typedData);
    await addWalletSpend(row.id, guard.valueUsd);
    return c.json({ signature, address: row.address });
  } catch (e: any) {
    return c.json({ error: "sign_failed", detail: String(e?.message ?? e) }, 502);
  }
});

/**
 * Move winnings out — the ONE sanctioned exit. The wallet signs (via Circle) an
 * EIP-3009 transfer to the account's BOUND address; the platform broadcasts it
 * (gasless for the hunter). Destination is the recovery-gated bound address, so a
 * stolen walletToken can only ever send the hunter's own funds to the hunter's
 * own address — never a drain.
 */
app.post("/api/v1/wallets/:id/payout", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const token = bearer(c);
  if (!token) return c.json({ error: "missing_wallet_token" }, 401);
  const row = await walletByToken(c.req.param("id"), await hashToken(token));
  if (!row) return c.json({ error: "invalid_wallet_token" }, 401);
  if (!row.account_id) return c.json({ error: "wallet_not_linked", detail: "This wallet is not under an account; no bound address to pay out to." }, 409);
  const acct = await getAccount(row.account_id);
  if (!acct?.bound_withdraw_address)
    return c.json({ error: "no_bound_address", detail: "Bind a withdrawal address (recovery-gated) before paying out." }, 409);

  const body = await c.req.json().catch(() => ({}) as any);
  const usd = Number(body?.amountUsd ?? 0);
  if (!(usd > 0)) return c.json({ error: "bad_amount" }, 422);
  const net = netById(row.network) ?? NET;
  const to = acct.bound_withdraw_address as `0x${string}`;
  const value = BigInt(Math.round(usd * 10 ** net.usdcDecimals));
  const nonce = ("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")) as `0x${string}`;
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // Build the EIP-3009 typed data, have Circle sign it, then broadcast it.
  const typedData = {
    domain: { name: net.usdcName, version: net.usdcVersion, chainId: net.chainId, verifyingContract: net.usdc },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" } ],
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] },
    primaryType: "TransferWithAuthorization",
    message: { from: row.address, to, value: value.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce },
  };
  try {
    const signature = await signTypedData(row.provider_id, typedData);
    const res = await treasury().submitTransferAuthorization(net.key, { from: row.address, to, value, validAfter, validBefore, nonce }, signature as `0x${string}`);
    if (!res.ok) return c.json({ error: "payout_broadcast_failed", detail: res.error }, 502);
    // Winnings are now in the hunter's own (bound) wallet. Offer the Ramp off-ramp
    // so the human can sell USDC → their bank/card (Ramp runs the KYC). null on testnet.
    const offramp = offrampUrl(to, net, usd);
    return c.json({ ok: true, to, amountUsd: usd, txHash: res.txHash, explorerUrl: res.explorerUrl,
      cashOut: offramp ? { provider: "Ramp Network", url: offramp, note: "Open to sell this USDC to your bank/card." }
        : { available: false, reason: "No fiat off-ramp for testnet tokens." } });
  } catch (e: any) {
    return c.json({ error: "payout_failed", detail: String(e?.message ?? e) }, 502);
  }
});

/** Rotate a wallet's runtime token (account-authed): new token, old one revoked. */
app.post("/api/v1/wallets/:id/rotate", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const owner = await resolveOwner(c);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  const wallet = await getAgentWallet(c.req.param("id"));
  if (!wallet) return c.json({ error: "not_found" }, 404);
  // Only the owning account (or admin) may rotate.
  const isOwner = owner.ref === accountRef(wallet.account_id ?? "__none__") || bearer(c) === ADMIN_TOKEN;
  if (!isOwner) return c.json({ error: "forbidden" }, 403);
  const newToken = `w402_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
  await db.run("UPDATE agent_wallets SET token_hash = ?, revoked_at = NULL, last_used_at = datetime('now') WHERE id = ?", [await hashToken(newToken), wallet.id]);
  return c.json({ walletId: wallet.id, walletToken: newToken, note: "Old token is now invalid. Store this one." });
});

// ── custodial balance layer (fiat + crypto → one internal balance) ───────────
//
// Everything here is gated on CUSTODY_ENABLED (off in prod until the money-
// transmission question is answered) and testnet + Stripe sandbox only.
//
// owner_ref binding:
//  - admin token asserting on behalf of a portal-authenticated user (the Next
//    company-api proxies verify the Supabase session, then pass ownerRef=email);
//  - a wallet bearer token (X-Wallet-Id + Authorization) for an agent acting as
//    its own address. A client can never set an owner_ref it hasn't proven.
const bearer = (c: any): string => (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
async function resolveOwner(
  c: any, requestedRef?: unknown,
): Promise<{ ref: string } | { error: string; code: number }> {
  const auth = bearer(c);
  if (auth && auth === ADMIN_TOKEN) {
    const ref = requestedRef ?? c.req.query("ownerRef") ?? c.req.header("x-owner-ref");
    if (!ref) return { error: "ownerRef_required", code: 400 };
    return { ref: String(ref).toLowerCase() };
  }
  // Account API key — the durable identity. owner_ref = account:<id>, so balance
  // and rewards follow the account across sessions and lost wallet keys.
  if (auth.startsWith("mb_ak_")) {
    const accountId = await resolveApiKey(auth);
    if (accountId) return { ref: accountRef(accountId) };
  }
  const walletId = c.req.header("x-wallet-id");
  if (walletId && auth) {
    const row = await walletByToken(walletId, await hashToken(auth));
    if (row) return { ref: row.address.toLowerCase() };
  }
  return { error: "unauthorized", code: 401 };
}
const custodyOff = (c: any) =>
  !CUSTODY_ENABLED ? c.json({ error: "custody_disabled", detail: "CUSTODY_ENABLED is not set on this deployment." }, 501) : null;

let _treasury: ReturnType<typeof treasuryFromEnv> | null = null;
const treasury = () => (_treasury ??= treasuryFromEnv());

/** What the portal needs to render the deposit UI. */
app.get("/api/v1/custody/config", (c) =>
  c.json({
    enabled: CUSTODY_ENABLED,
    stripe: stripeConfigured(),
    stripeWebhookReady: stripeWebhookReady(),
    publishableKey: STRIPE_PUBLISHABLE_KEY || null,
    depositAddress: PLATFORM_DEPOSIT_ADDRESS || null,
    networks: ENABLED.map((n) => ({ key: n.key, id: n.id, name: n.name, testnet: n.testnet })),
  }),
);

// ── accounts: the durable identity that owns the balance ─────────────────────

/**
 * Register an account on the first curl. Returns an api_key (the runtime
 * credential) AND a recovery code — BOTH shown once. The recovery code is
 * mandatory: it is what re-mints an api_key if the agent's key is ever lost, so
 * a lost key never loses the money. Open registration (trust-on-first-use); an
 * account only matters once it is funded.
 */
app.post("/api/v1/accounts/register", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const body = await c.req.json().catch(() => ({}) as any);
  const kind: AccountKind = body?.kind === "company" ? "company" : "hunter";
  const accountId = await createAccount(kind);
  const apiKey = await issueCredential(accountId, "api_key", body?.label ? String(body.label).slice(0, 64) : "initial");
  const recoveryCode = await issueCredential(accountId, "recovery");
  // Identity is platform-owned, created at signup — not the agent's or company's
  // job. On testnet there are no ERC-8004 registries, so it's a clean skip and
  // submissions are never blocked; on mainnet the platform registers it (via the
  // account's Circle wallet, gas sponsored) — see /api/agents/:address/identity.
  const identityStatus = NET.testnet ? "skipped_testnet" : "pending_mainnet";
  await db.run("UPDATE accounts SET identity_status = ? WHERE id = ?", [identityStatus, accountId]);
  return c.json({
    accountId, kind, apiKey, recoveryCode, identityStatus,
    ownerRef: accountRef(accountId),
    note: "STORE BOTH NOW — shown once. Use apiKey as `Authorization: Bearer <apiKey>` for account/wallet/balance calls. Keep recoveryCode OFFLINE (not next to the api key): it re-mints an apiKey if the key is lost, and is required to change the withdrawal address.",
  }, 201);
});

/**
 * Recover an account: present the recovery code, get a FRESH api_key. Every
 * existing api_key is revoked (a thief holding the old one is locked out) and
 * the recovery code is rotated, so store the new pair.
 */
app.post("/api/v1/accounts/recover", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const body = await c.req.json().catch(() => ({}) as any);
  const code = String(body?.recoveryCode ?? "");
  const accountId = await verifyRecovery(code);
  if (!accountId) return c.json({ error: "invalid_recovery_code" }, 401);
  await revokeApiKeys(accountId);                       // lock out any lost/leaked key
  const apiKey = await issueCredential(accountId, "api_key", "recovered");
  const recoveryCode = await rotateRecovery(accountId); // one-time use, rotate it
  return c.json({
    accountId, apiKey, recoveryCode, ownerRef: accountRef(accountId),
    note: "Recovered. Old api keys are revoked. Store the NEW apiKey + recoveryCode; your balance is unchanged.",
  });
});

/** Mint an additional api_key for the authenticated account (e.g. per agent). */
app.post("/api/v1/accounts/keys", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const owner = await resolveOwner(c);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  if (!owner.ref.startsWith("account:")) return c.json({ error: "not_an_account" }, 400);
  const accountId = owner.ref.slice("account:".length);
  const body = await c.req.json().catch(() => ({}) as any);
  const apiKey = await issueCredential(accountId, "api_key", body?.label ? String(body.label).slice(0, 64) : "additional");
  return c.json({ apiKey, note: "Shown once." }, 201);
});

/**
 * Bind/change the withdrawal address (the backstop). Authorised by the RECOVERY
 * CODE, not an api key — changing where money can go is a root action, so a
 * leaked runtime credential (api key or walletToken) can never redirect funds.
 */
app.post("/api/v1/accounts/bind-withdrawal", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const body = await c.req.json().catch(() => ({}) as any);
  const addr = String(body?.address ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return c.json({ error: "bad_address" }, 422);
  const accountId = await verifyRecovery(String(body?.recoveryCode ?? ""));
  if (!accountId) return c.json({ error: "recovery_code_required", detail: "Changing the withdrawal address requires the account recovery code." }, 401);
  await setBoundWithdrawAddress(accountId, addr.toLowerCase());
  return c.json({ ok: true, boundWithdrawAddress: addr.toLowerCase() });
});

/** Who am I — resolve the caller's account + balance. */
app.get("/api/v1/accounts/me", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const owner = await resolveOwner(c);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  const out: any = { ownerRef: owner.ref, balanceUsd: await balanceUsd(userRef(owner.ref)) };
  if (owner.ref.startsWith("account:")) {
    const a = await getAccount(owner.ref.slice("account:".length));
    if (a) { out.accountId = a.id; out.kind = a.kind; out.boundWithdrawAddress = a.bound_withdraw_address; }
  }
  return c.json(out);
});

/**
 * Cash-out link: a Ramp off-ramp URL to sell USDC → bank/card from a wallet the
 * human controls (their bound address by default). Ramp runs the KYC; the
 * platform just hands over the prefilled URL. Mainnet only (no testnet fiat).
 */
app.get("/api/v1/offramp", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const owner = await resolveOwner(c);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  const usd = Number(c.req.query("amountUsd") ?? 0);
  const net = netById(c.req.query("network") ?? "") ?? NET;
  let address = String(c.req.query("address") ?? "");
  if (!address && owner.ref.startsWith("account:")) {
    const a = await getAccount(owner.ref.slice("account:".length));
    address = a?.bound_withdraw_address ?? "";
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    return c.json({ error: "no_address", detail: "Bind a withdrawal address (recovery-gated) or pass ?address=." }, 409);
  const url = offrampUrl(address, net, usd > 0 ? usd : undefined);
  if (!url) return c.json({ available: false, reason: "No fiat off-ramp for testnet tokens." });
  return c.json({ available: true, provider: "Ramp Network", address, url });
});

/** The caller's own balance + recent deposits/withdrawals/history. */
app.get("/api/v1/balance", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const owner = await resolveOwner(c);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  const atomic = await balanceAtomic(userRef(owner.ref));
  return c.json({
    ownerRef: owner.ref,
    balanceUsd: fromAtomic(atomic),
    balanceAtomic: atomic.toString(),
    deposits: (await listDeposits(owner.ref)).map((d) => ({ id: d.id, rail: d.rail, usd: fromAtomic(d.amount_atomic), status: d.status, chainTx: d.chain_tx, createdAt: d.created_at })),
    withdrawals: (await listWithdrawals(owner.ref)).map((w) => ({ id: w.id, usd: fromAtomic(w.amount_atomic), to: w.to_address, status: w.status, chainTx: w.chain_tx, createdAt: w.created_at })),
    history: (await ledgerHistory(userRef(owner.ref), 25)).map((h) => ({ usd: fromAtomic(h.deltaAtomic), memo: h.memo, at: h.createdAt })),
  });
});

/** Fiat rail: create a Stripe Checkout Session for a top-up. */
app.post("/api/v1/deposits/stripe", async (c) => {
  const off = custodyOff(c); if (off) return off;
  if (!stripeConfigured()) return c.json({ error: "stripe_not_configured" }, 501);
  const body = await c.req.json().catch(() => ({}) as any);
  const owner = await resolveOwner(c, body.ownerRef);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  const usd = Number(body.amountUsd ?? 0);
  if (!(usd > 0)) return c.json({ error: "bad_amount" }, 422);
  const kind = body.kind === "company" ? "company" : "hunter";
  const id = crypto.randomUUID();
  try {
    const session = await createCheckoutSession({ ownerRef: owner.ref, depositId: id, amountUsd: usd, kind });
    await createDeposit(id, owner.ref, "stripe", toAtomic(usd), session.sessionId);
    return c.json({ depositId: id, url: session.url, amountUsd: usd });
  } catch (e: any) {
    return c.json({ error: "stripe_checkout_failed", detail: String(e?.message ?? e) }, 502);
  }
});

/**
 * Stripe webhook — the money is only real once this fires. Verifies the raw
 * body against the signing secret, then credits the balance idempotently
 * (creditDeposit is a no-op if the txId was already posted, so a re-delivered
 * event cannot double-credit). No bearer auth: the signature IS the auth.
 */
app.post("/api/stripe/webhook", async (c) => {
  const off = custodyOff(c); if (off) return off;
  if (!stripeWebhookReady()) return c.json({ error: "stripe_webhook_not_configured", detail: "Set STRIPE_WEBHOOK_SECRET (from `stripe listen`)." }, 501);
  const sig = c.req.header("stripe-signature") ?? "";
  const raw = await c.req.text();
  let event: any;
  try { event = await verifyWebhook(raw, sig); }
  catch (e: any) { return c.json({ error: "bad_signature", detail: String(e?.message ?? e) }, 400); }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object;
    const depositId = s?.metadata?.depositId as string | undefined;
    const dep = depositId ? await getDeposit(depositId) : (s?.id ? await getDepositByProvider("stripe", s.id) : null);
    if (dep && dep.status === "open") {
      const atomic = BigInt(dep.amount_atomic);
      const txId = `stripe-deposit-${dep.id}`;
      await creditDeposit(dep.owner_ref, atomic, "stripe", txId, `card deposit ${dep.id}`);
      await markDepositCredited(dep.id, txId, null);
      // Capture the payment_intent so this deposit can later be refunded to the card.
      const pi = typeof s?.payment_intent === "string" ? s.payment_intent : s?.payment_intent?.id;
      if (pi) await setDepositPaymentIntent(dep.id, pi);
      // Conversion seam: on testnet a no-op; in prod this buys treasury USDC.
      fiatToUsdc(fromAtomic(atomic)).then((r) => console.log(`[custody] ${dep.id} conversion: ${r.detail}`)).catch(() => {});
      console.log(`[custody] stripe deposit ${dep.id} credited ${dep.owner_ref} +$${fromAtomic(atomic)}`);
    }
  }
  return c.json({ received: true });
});

/** Crypto rail: hand back the deposit address + a UNIQUE exact amount to send. */
app.post("/api/v1/deposits/crypto", async (c) => {
  const off = custodyOff(c); if (off) return off;
  if (!/^0x[0-9a-fA-F]{40}$/.test(PLATFORM_DEPOSIT_ADDRESS)) return c.json({ error: "no_deposit_address" }, 501);
  const body = await c.req.json().catch(() => ({}) as any);
  const owner = await resolveOwner(c, body.ownerRef);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  const usd = Number(body.amountUsd ?? 0);
  if (!(usd > 0)) return c.json({ error: "bad_amount" }, 422);
  const net = netById(body.network) ?? NET;
  // Unique sub-cent offset so concurrent sends are distinguishable by amount.
  const expected = toAtomic(usd) + BigInt(1 + Math.floor(Math.random() * 999));
  const id = crypto.randomUUID();
  await createDeposit(id, owner.ref, "onchain", expected, id);
  return c.json({
    depositId: id,
    network: net.id,
    token: net.usdc,
    to: PLATFORM_DEPOSIT_ADDRESS,
    sendExactUsdc: fromAtomic(expected),
    sendExactAtomic: expected.toString(),
    note: "Send EXACTLY this amount of USDC to the address on this network. It is credited automatically once seen on-chain.",
    ...(net.testnet ? {} : { rampUrl: rampUrl(PLATFORM_DEPOSIT_ADDRESS, net, usd) }),
  });
});

/** Company: fund a bounty's reward pool from balance (chain hidden). */
app.post("/api/programs/:slug/fund-from-balance", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const slug = c.req.param("slug");
  const p = await getProgramRow(slug);
  if (!p || !p.rules_hash) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({}) as any);
  const owner = await resolveOwner(c, body.ownerRef);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  const usd = Number(body.amountUsd ?? 0);
  if (!(usd > 0)) return c.json({ error: "bad_amount" }, 422);
  const txId = `fund-${slug}-${crypto.randomUUID()}`;
  try { await moveUserToProgram(owner.ref, slug, toAtomic(usd), txId, `fund ${slug}`); }
  catch (e: any) { return c.json({ error: "insufficient_balance", detail: String(e?.message ?? e) }, 422); }
  const fundedTotal = await recordProgramFunding(slug, usd);
  return c.json({
    slug, fundedUsd: fundedTotal, committedUsd: p.pool_committed_usd,
    solvent: fundedTotal >= p.pool_committed_usd,
    balanceUsd: await balanceUsd(userRef(owner.ref)),
  });
});

/** Withdraw balance to the user's own wallet — the escape hatch to self-custody. */
app.post("/api/v1/withdrawals", async (c) => {
  const off = custodyOff(c); if (off) return off;
  const body = await c.req.json().catch(() => ({}) as any);
  const owner = await resolveOwner(c, body.ownerRef);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);
  const to = String(body.toAddress ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return c.json({ error: "bad_address" }, 422);
  // Backstop: if the account bound a withdrawal address, payouts go ONLY there,
  // so a leaked api_key cannot redirect funds. Changing it is a separate action.
  if (owner.ref.startsWith("account:")) {
    const acct = await getAccount(owner.ref.slice("account:".length));
    if (acct?.bound_withdraw_address && acct.bound_withdraw_address !== to.toLowerCase())
      return c.json({ error: "withdrawal_address_not_bound", detail: `This account withdraws only to ${acct.bound_withdraw_address}. Rebind to change it.` }, 403);
  }
  const usd = Number(body.amountUsd ?? 0);
  if (!(usd > 0)) return c.json({ error: "bad_amount" }, 422);
  const net = netById(body.network) ?? NET;
  const atomic = toAtomic(usd);
  const id = crypto.randomUUID();
  const txId = `withdrawal-${id}`;

  // Debit the ledger FIRST (this also enforces sufficient balance), then pay.
  try { await debitWithdrawal(owner.ref, atomic, txId, `withdraw to ${to}`); }
  catch (e: any) { return c.json({ error: "insufficient_balance", detail: String(e?.message ?? e) }, 422); }
  await createWithdrawal(id, owner.ref, atomic, to, net.id);

  let pay;
  try { pay = await treasury().pay(to, usd, net.key); }
  catch (e: any) { pay = { ok: false, error: String(e?.message ?? e) } as any; }
  if (!pay.ok) {
    // Reverse the debit so a failed payout never strands the user's balance.
    await ledgerPost(`${txId}-refund`, "withdrawal failed refund", [
      { account: userRef(owner.ref), deltaAtomic: atomic },
      { account: externalRef("onchain_out"), deltaAtomic: -atomic },
    ]);
    await markWithdrawal(id, "failed", { error: pay.error });
    return c.json({ error: "payout_failed", detail: pay.error }, 502);
  }
  await markWithdrawal(id, "paid", { txId, chainTx: pay.txHash });
  return c.json({ ok: true, id, txHash: pay.txHash, explorerUrl: pay.explorerUrl, balanceUsd: await balanceUsd(userRef(owner.ref)) });
});

/**
 * Refund deposited fiat back to the payer's card (the fiat exit). Bounded by the
 * lesser of the account's current balance and the remaining refundable amount
 * across its Stripe deposits. Money returns ONLY to the original card — Stripe
 * won't redirect it — so this is safe under a plain api key. Omit amountUsd to
 * refund the maximum (the "remaining deposit balance").
 */
app.post("/api/v1/refunds", async (c) => {
  const off = custodyOff(c); if (off) return off;
  if (!stripeConfigured()) return c.json({ error: "stripe_not_configured" }, 501);
  const body = await c.req.json().catch(() => ({}) as any);
  const owner = await resolveOwner(c, body.ownerRef);
  if ("error" in owner) return c.json({ error: owner.error }, owner.code as any);

  const balance = await balanceAtomic(userRef(owner.ref));
  const deposits = await listRefundableStripeDeposits(owner.ref);
  const totalRefundable = deposits.reduce((s, d) => s + (BigInt(d.amount_atomic) - BigInt(d.refunded_atomic)), 0n);
  const maxRefund = balance < totalRefundable ? balance : totalRefundable;
  if (maxRefund <= 0n) return c.json({ error: "nothing_refundable", detail: "No refundable Stripe deposit balance." }, 422);

  const requested = body.amountUsd != null ? toAtomic(Number(body.amountUsd)) : maxRefund;
  if (requested <= 0n) return c.json({ error: "bad_amount" }, 422);
  if (requested > maxRefund)
    return c.json({ error: "exceeds_refundable", detail: `max refundable now is $${fromAtomic(maxRefund)} (min of balance $${fromAtomic(balance)} and remaining deposits $${fromAtomic(totalRefundable)})` }, 422);

  let left = requested;
  const refunds: any[] = [];
  for (const dep of deposits) {
    if (left <= 0n) break;
    const depRemaining = BigInt(dep.amount_atomic) - BigInt(dep.refunded_atomic);
    const portion = depRemaining < left ? depRemaining : left;
    if (portion <= 0n) continue;
    const portionUsd = fromAtomic(portion);
    try {
      const refund = await createRefund(dep.stripe_payment_intent!, portionUsd);
      await ledgerPost(`refund-${dep.id}-${refund.id}`, `stripe refund ${dep.id}`, [
        { account: userRef(owner.ref), deltaAtomic: -portion },
        { account: externalRef("stripe"), deltaAtomic: portion },
      ]);
      await addDepositRefunded(dep.id, portion);
      refunds.push({ depositId: dep.id, refundId: refund.id, usd: portionUsd, status: refund.status });
      left -= portion;
    } catch (e: any) {
      // Stop on the first Stripe error; report what already succeeded.
      return c.json({ error: "refund_failed", detail: String(e?.message ?? e), refundedUsd: fromAtomic(requested - left), refunds, balanceUsd: await balanceUsd(userRef(owner.ref)) }, 502);
    }
  }
  return c.json({ ok: true, refundedUsd: fromAtomic(requested - left), refunds, balanceUsd: await balanceUsd(userRef(owner.ref)) });
});

/** Solvency reconciliation: what we owe vs. what we actually hold. */
app.get("/api/admin/solvency", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  let backingUsd = 0;
  try { for (const n of ENABLED) { const b = await treasury().balance(n.key).catch(() => null); if (b) backingUsd += b.usdc; } }
  catch { /* no treasury key — report claims only */ }
  const integ = await integrity(toAtomic(backingUsd));
  return c.json({
    claimsUsd: integ.claimsUsd,
    treasuryUsdcUsd: backingUsd,
    backingUsd: integ.backingUsd,
    driftUsd: fromAtomic(integ.driftAtomic),
    invariantHolds: integ.driftAtomic === 0n,
    solvent: integ.solvent,
  });
});

// ── static ──────────────────────────────────────────────────────────────────
app.get("/", async (c) => c.html(await Bun.file(`${import.meta.dir}/web/index.html`).text()));
app.get("/company", async (c) => c.html(await Bun.file(`${import.meta.dir}/web/company.html`).text()));
app.get("/triage", async (c) => c.html(await Bun.file(`${import.meta.dir}/web/triage.html`).text()));
app.get("/docs", async (c) => c.html(await Bun.file(`${import.meta.dir}/web/docs.html`).text()));

console.log(
  `bounty402 on :${PORT}  networks=${ENABLED.map((n) => `${n.key}(${n.id})`).join(",")}  ` +
    ENABLED.map((n) => `payTo[${n.key}]=${payToFor(n)}`).join("  ") +
    (CUSTODY_ENABLED ? `  custody=on stripe=${stripeConfigured()} deposit=${PLATFORM_DEPOSIT_ADDRESS || "unset"}` : "  custody=off"),
);

// Crypto deposit rail: start watching the platform address for incoming USDC.
startDepositWatcher();

export default { port: PORT, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 60 };
