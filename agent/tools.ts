/**
 * The bounty402 hunter toolkit.
 *
 * A framework-agnostic set of tools an autonomous agent uses to fund itself,
 * check its record, write findings up, and submit them over x402. Every tool
 * is a plain async function returning a JSON-serialisable result — wire them
 * into Claude tool-use (see agent.ts), any other framework, or call directly.
 *
 * The agent owns exactly one capability that costs money — submitting a bond —
 * and it always knows the price before it pays (check_wallet / list_programs
 * quote it). It cannot move funds anywhere except a program's payTo.
 */
import { AgentWallet } from "./wallet";
import { makePayingClient, readChallenge } from "./x402";
import { NETWORKS, type NetKey } from "../lib/config";
import { registerCalldata, agentIdFromReceipt, ERC8004 } from "../lib/erc8004";
import { createWalletClient, createPublicClient, http, defineChain, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

export interface ToolContext {
  wallet: AgentWallet;
  privateKey: string;
  baseUrl: string;
  network: NetKey;
}

const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  program: string;
  title: string;
  severity: Severity;
  summary: string;
  asset?: string;
  poc?: string;
}

async function j(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── read-only tools ─────────────────────────────────────────────────────────

/**
 * Generate a fresh wallet for this session. The agent keeps the returned
 * privateKey (it signs x402 bonds); the human funds the address with USDC.
 * No custody service needed — the agent owns its own key, like the local-key
 * path. There is no withdraw beyond paying bonds.
 */
export function create_wallet(_ctx: ToolContext, args?: { network?: string }) {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return {
    address, privateKey, network: args?.network ?? "testnet",
    note: "Fresh wallet created. KEEP privateKey for this session — it authorises your x402 bonds. " +
      "Ask the human to fund " + address + " with USDC before you submit. You need only USDC.",
  };
}

export async function check_wallet(ctx: ToolContext) {
  const status = await ctx.wallet.status();
  const here = status.balances.find((b) => b.network === ctx.network);
  return {
    address: status.address,
    fundingNetwork: ctx.network,
    usdcHere: here?.usdc ?? 0,
    monHere: here?.mon ?? 0,
    allBalances: status.balances,
    note:
      "Bonds are paid in USDC. The facilitator sponsors settlement gas, so MON is " +
      "only needed to acquire USDC or deploy contracts. Fund USDC to `address`.",
  };
}

export async function list_programs(ctx: ToolContext) {
  const data = await j(await fetch(`${ctx.baseUrl}/api/programs`));
  return {
    programs: (data.programs ?? []).map((p: any) => ({
      slug: p.slug,
      name: p.name,
      type: (p.acceptedImpacts ?? []).some((i: string) => i.startsWith("web-")) ? "web-app" : "smart-contract",
      target: p.target,
      maxBountyUsd: p.payouts?.critical ?? null,
      rewardRange: p.rewardRange,
      submissionPriceUsd: p.bondUsd,
      pocGateUsd: p.pocBondUsd,
      poolFundedUsd: p.pool?.fundedUsd ?? null,
      poolSolvent: p.pool?.solvent ?? null,
    })),
    next: "Show these to the human and ask which program to work on. Then call get_scope(slug) for the full scope before planning.",
    hint: "submissionPriceUsd is the base bond; your quoted price may be lower with a track record. Only bond on a program whose pool is solvent.",
  };
}

/**
 * Full scope for one program: what is in and out of scope, which impacts pay
 * (and which are provable by an executable PoC), the payout per severity, the
 * bond, and whether the rules are the committed on-chain ones. Call this after
 * the human picks a program, and plan against it.
 */
export async function get_scope(ctx: ToolContext, args: { slug: string }) {
  const d = await j(await fetch(`${ctx.baseUrl}/api/programs/${args.slug}/rules`));
  if (d?.error) return { error: d.error, hint: "Call list_programs for valid slugs." };
  const r = d.rules ?? {};
  return {
    slug: d.slug,
    name: r.name,
    target: r.target,
    inScope: r.scopeIn ?? [],
    outOfScope: r.scopeOut ?? [],
    impacts: (d.impacts ?? []).map((i: any) => ({
      id: i.id, severity: i.severity, label: i.label,
      pocProvable: Boolean(i.machineCheckable),
    })),
    payoutsUsd: r.payouts ?? {},
    submissionPriceUsd: r.bondUsd,
    slaDays: r.slaSeconds ? Math.round(r.slaSeconds / 86400) : null,
    rulesCommittedOnChain: Boolean(d.verified),
    rulesHash: d.rulesHash,
    poolSolvent: d.pool?.solvent ?? null,
    plan: "Pick ONE in-scope impact you can actually demonstrate. Prefer a pocProvable impact: " +
      "its severity (and payout) is settled by executing the PoC, not argued. Draft the finding, " +
      "check you can afford the bond, then submit.",
  };
}

export async function get_my_reputation(ctx: ToolContext) {
  const r = await j(await fetch(`${ctx.baseUrl}/api/hunters/${ctx.wallet.address}`));
  return {
    address: ctx.wallet.address,
    tier: r.tier ?? "unknown",
    bondMultiplier: r.bondMultiplier ?? 1,
    submitted: r.submitted ?? 0,
    valid: r.valid ?? 0,
    slop: r.slop ?? 0,
    signalRate: r.signalRate ?? null,
    paidOutUsd: r.paidOutUsd ?? 0,
    history: (r.history ?? []).slice(0, 20),
    note:
      "A better record lowers your bond. Two junk submissions double it. Do not " +
      "submit unless you believe the finding is real and in scope.",
  };
}

/**
 * Register an ERC-8004 identity on Monad — a portable, on-chain agent identity
 * owned by the same wallet that pays your bonds. Companies read its reputation.
 * This mints an ERC-721 on the Identity Registry with your agent card as the
 * tokenURI; it is an on-chain transaction and needs MON for gas.
 */
export async function register_identity(ctx: ToolContext) {
  const net = NETWORKS[ctx.network];
  if (ctx.network !== "mainnet") {
    return { registered: false, skipped: true, network: ctx.network,
      reason: "ERC-8004 registries are deployed on Monad mainnet only; registration is skipped on testnet. " +
        "Submissions are not blocked here (identity is enforced on mainnet)." };
  }
  const address = ctx.wallet.address as `0x${string}`;
  const agentURI = `${ctx.baseUrl}/api/agents/${address}/card`;
  const chain = defineChain({
    id: net.chainId, name: net.name,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [net.rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(net.rpc) });
  let bal = await pub.getBalance({ address });
  if (bal < parseEther("0.005")) {
    // Ask the platform/company to sponsor the one-time registration gas — the
    // agent experience should need only USDC.
    const sponsor = await fetch(`${ctx.baseUrl}/api/agents/${address}/sponsor-gas`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ network: ctx.network }),
    }).then((r) => r.json()).catch(() => null);
    bal = await pub.getBalance({ address });
    if (bal < parseEther("0.005")) {
      return { registered: false, needsGas: true, registry: ERC8004.identity, agentURI, sponsor,
        message: `Registration needs gas and platform sponsorship is unavailable ` +
          `(${sponsor?.reason ?? "no response"}). Ask the human to send a little MON to ${address}, then retry.` };
    }
  }
  const account = privateKeyToAccount(ctx.privateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(net.rpc) });
  const hash = await wallet.sendTransaction({ to: ERC8004.identity, data: registerCalldata(agentURI) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const agentId = agentIdFromReceipt(receipt.logs as any);
  if (agentId != null) {
    await fetch(`${ctx.baseUrl}/api/agents/${address}/identity`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: agentId.toString(), txHash: hash }),
    }).catch(() => {});
  }
  return { registered: true, agentId: agentId?.toString() ?? null, txHash: hash,
    registry: ERC8004.identity, explorer: `${net.explorer}/tx/${hash}`,
    note: "Identity minted. Your track record now accrues to this on-chain agentId, portable across programs." };
}

export async function check_report(ctx: ToolContext, args: { id: string }) {
  return j(await fetch(`${ctx.baseUrl}/api/v1/reports/${args.id}`));
}

// ── internal writeup tool (no network, no payment) ──────────────────────────

/**
 * Validate and normalise a finding into the exact submission shape, catching
 * the things that would waste a bond on a 422: too-short summary, bad severity,
 * missing PoC. Returns { ok, finding } or { ok:false, problems } so the agent
 * fixes the writeup before paying.
 */
export function draft_writeup(_ctx: ToolContext, f: Finding) {
  const problems: string[] = [];
  if (!f.program) problems.push("program is required");
  if (!f.title || f.title.trim().length < 8) problems.push("title must be >= 8 chars");
  if (!SEVERITIES.includes(f.severity)) problems.push(`severity must be one of ${SEVERITIES.join(", ")}`);
  if (!f.summary || f.summary.trim().length < 80)
    problems.push(`summary must be >= 80 chars (got ${f.summary?.trim().length ?? 0})`);
  if (f.poc !== undefined && f.poc.trim().length < 40)
    problems.push("poc, if provided, must be >= 40 chars");
  if (problems.length) return { ok: false as const, problems };
  return {
    ok: true as const,
    finding: {
      program: f.program,
      title: f.title.trim(),
      severity: f.severity,
      summary: f.summary.trim(),
      asset: f.asset?.trim() || undefined,
      poc: f.poc?.trim() || undefined,
    },
  };
}

// ── funding: ask a human ────────────────────────────────────────────────────

export async function request_funding(ctx: ToolContext, args: { needUsd: number; reason?: string; program?: string }) {
  const status = await ctx.wallet.status();
  const here = status.balances.find((b) => b.network === ctx.network);
  const req = await j(
    await fetch(`${ctx.baseUrl}/api/funding-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: ctx.wallet.address,
        network: NETWORKS[ctx.network].id,
        needUsd: args.needUsd,
        haveUsd: here?.usdc ?? 0,
        reason: args.reason,
        program: args.program,
      }),
    }),
  );
  // The server returns both funding paths. Surface them as one instruction the
  // agent can read out verbatim, so a human who would rather pay by card than
  // move USDC is not stuck.
  const fiat = (req as any)?.fiat;
  return {
    ...req,
    action: "A human has been asked to fund the wallet. Poll wait_for_funding next.",
    fundInstructions:
      `Send >= ${args.needUsd} USDC (${NETWORKS[ctx.network].usdc}) to ${ctx.wallet.address} ` +
      `on ${NETWORKS[ctx.network].name}.` +
      (fiat?.available
        ? ` Or pay by card, Apple Pay or bank transfer — it lands as USDC on Monad at this address: ${fiat.url}`
        : fiat?.reason
          ? ` ${fiat.reason}`
          : ""),
  };
}

/** Poll the wallet until it can cover `needUsd`, or timeout. Confirms the request when funded. */
export async function wait_for_funding(
  ctx: ToolContext,
  args: { needUsd: number; requestId?: string; timeoutSec?: number; pollSec?: number },
) {
  const deadline = Date.now() + (args.timeoutSec ?? 600) * 1000;
  const poll = (args.pollSec ?? 15) * 1000;
  while (Date.now() < deadline) {
    const a = await ctx.wallet.canAfford(args.needUsd, ctx.network);
    if (a.ok) {
      if (args.requestId)
        await fetch(`${ctx.baseUrl}/api/funding-requests/${args.requestId}/confirm`, { method: "POST" }).catch(() => {});
      return { funded: true, have: a.have, need: a.need, network: ctx.network };
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  const a = await ctx.wallet.canAfford(args.needUsd, ctx.network);
  return { funded: false, have: a.have, need: a.need, network: ctx.network, note: "Timed out waiting for funding." };
}

// ── paid tools: submit ──────────────────────────────────────────────────────

/**
 * Submit a finding. Pays the bond over x402 in the same call. If the wallet is
 * short, returns { paid:false, insufficientFunds, quoted } so the agent can
 * request_funding rather than throwing.
 */
export async function submit_finding(ctx: ToolContext, f: Finding) {
  const draft = draft_writeup(ctx, f);
  if (!draft.ok) return { paid: false as const, error: "invalid_writeup", problems: draft.problems };

  const pc = makePayingClient(ctx.privateKey, { network: ctx.network });
  // Quote at our own tier on the probe so the signed amount matches the paid retry
  // (the server reprices the retry from the payer; without this a discounted hunter mismatches).
  const url = `${ctx.baseUrl}/api/v1/reports?program=${encodeURIComponent(f.program)}&hunter=${ctx.wallet.address}`;
  const res = await pc.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft.finding),
  });

  if (res.status === 402) {
    const ch = readChallenge(res);
    const offer = ch?.offers.find((o) => o.network === NETWORKS[ctx.network].id) ?? ch?.offers[0];
    const quoted = offer ? Number(offer.amount) / 10 ** NETWORKS[ctx.network].usdcDecimals : null;
    return { paid: false as const, insufficientFunds: ch?.reason === "insufficient_funds", reason: ch?.reason, quotedUsd: quoted };
  }
  const body = await j(res);
  return { paid: res.ok, status: body.status, id: body.id, bondUsd: body.bondUsd, reputation: body.reputation, nextStep: body.nextStep, body };
}

/** Pay the second gate to attach a PoC. Same network as the bond. */
export async function submit_poc(ctx: ToolContext, args: { id: string; poc: string }) {
  if (!args.poc || args.poc.trim().length < 40) return { paid: false as const, error: "poc_too_short" };
  const pc = makePayingClient(ctx.privateKey, { network: ctx.network });
  const res = await pc.fetch(`${ctx.baseUrl}/api/v1/reports/${args.id}/poc?hunter=${ctx.wallet.address}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ poc: args.poc.trim() }),
  });
  if (res.status === 402) {
    const ch = readChallenge(res);
    return { paid: false as const, insufficientFunds: ch?.reason === "insufficient_funds", reason: ch?.reason };
  }
  return { paid: res.ok, ...(await j(res)) };
}

export const TOOLS = {
  create_wallet, check_wallet, list_programs, get_scope, get_my_reputation, register_identity, check_report,
  draft_writeup, request_funding, wait_for_funding, submit_finding, submit_poc,
} as const;
export type ToolName = keyof typeof TOOLS;
