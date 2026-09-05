// Hunter agent — live bounty selection, scored by demo/hunter/CRITERIA.md.
//
// Fetches every open monbounty program, checks the hunter's USDC liquidity on
// Monad + Solana, scores each bounty on Feasibility / Time / Economics /
// Liquidity, ranks them, and PUBLISHES THE DECISION TO SWARM so the agent's
// reasoning is itself an auditable, censorship-resistant artifact.
//
//   HUNTER_EVM=0x… HUNTER_SOL=… bun run demo/hunter/select.ts
//
import { swarmUpload, bzzUrl, SWARM_ENABLED } from "../../lib/swarm";
import { solBalance } from "../../lib/solana";

const BASE = process.env.MONBOUNTY_URL ?? "http://127.0.0.1:3044";
const HUNTER_EVM = process.env.HUNTER_EVM ?? "";
const HUNTER_SOL = process.env.HUNTER_SOL ?? "";
const DEMO_WINDOW_SEC = Number(process.env.DEMO_WINDOW_SEC ?? 900); // 15 min

const j = async (p: string) => (await fetch(`${BASE}${p}`)).json();

// ── liquidity: how much USDC the hunter holds, per rail ──────────────────────
async function liquidity() {
  let evmUsdc = 0, solUsdc = 0;
  if (HUNTER_EVM) {
    try { const s = await j(`/api/hunters/${HUNTER_EVM}/status`); evmUsdc = s?.wallet?.totalUsdc ?? 0; } catch {}
  }
  if (HUNTER_SOL) {
    try { const s = await j(`/api/solana/${HUNTER_SOL}/status`); solUsdc = s?.balances?.usdc ?? 0; } catch {}
  }
  return { evmUsdc, solUsdc, any: evmUsdc + solUsdc };
}

// estimated seconds to find + prove, by verification style
function estHuntSeconds(mode: string, impacts: any[]): number {
  const machine = impacts.filter((i) => i.machineCheckable).length;
  if (mode === "onchain-fork") return 600;          // write a Foundry PoC
  if (mode === "company-attested") return machine > 0 ? 240 : 360; // probe + replay
  return 900;                                        // unverifiable-ish, slow
}

interface Scored {
  slug: string; name: string; total: number;
  feasibility: number; time: number; economics: number; liquidityFit: number;
  gatesPass: boolean; gateFail: string | null;
  estSec: number; slaSec: number; ev: number; maxReward: number; totalBond: number;
  chain: string;
  ens: string | null; swarmRef: string | null; immutable: boolean;
}

async function scoreAll(): Promise<{ scored: Scored[]; liq: Awaited<ReturnType<typeof liquidity>>; solanaSettles: boolean }> {
  const [disc, liq] = await Promise.all([j("/api/programs"), liquidity()]);
  const { programs } = disc;
  // Solana can only SETTLE if the platform fee-payer holds SOL for tx fees.
  // If it doesn't, prefer Monad even though Solana would be "cheaper".
  let solanaSettles = false;
  try { if (disc.solana?.feePayer) solanaSettles = (await solBalance(disc.solana.feePayer)) > 0; } catch {}
  const rows: Scored[] = [];

  for (const p of programs) {
    if (!p.committed) continue; // only real (company) bounties have rules to prove
    let rules: any;
    try { rules = await j(`/api/programs/${p.slug}/rules`); } catch { continue; }
    const impacts: any[] = rules.impacts ?? [];
    const mode: string = p.verificationMode ?? "company-attested";
    const pool = rules.pool ?? p.pool ?? { fundedUsd: 0, committedUsd: 0 };
    const payouts = rules.rules?.payouts ?? p.payouts ?? {};
    const maxReward = Math.max(...Object.values(payouts).map(Number).filter((n) => !isNaN(n)), 0);
    const submitBond = p.bondUsd ?? 1;
    const pocBond = p.pocBondUsd ?? submitBond * 4;
    const totalBond = submitBond + pocBond;
    const slaSec = p.slaSeconds ?? rules.rules?.slaSeconds ?? 0;
    const estSec = estHuntSeconds(mode, impacts);

    // ── hard gates ──
    const solvent = (pool.fundedUsd ?? 0) >= (pool.committedUsd ?? 0) && (pool.fundedUsd ?? 0) > 0;
    const verifiable = mode === "company-attested" || mode === "onchain-fork";
    const liquid = liq.any >= totalBond;
    // Attackable target: a bounty is only workable if there's something to hit.
    // onchain-fork needs a DEPLOYED contract address (not a source path); a
    // company-attested bounty has a runnable target the verifier can reach.
    const target = String(rules.rules?.target ?? "");
    const attackable = mode === "company-attested"
      ? true
      : /0x[0-9a-fA-F]{40}/.test(target); // onchain-fork: needs a deployed address
    let gateFail: string | null = null;
    if (!liquid) gateFail = "no USDC to bond";
    else if (!solvent) gateFail = "reward pool not funded";
    else if (!verifiable) gateFail = "no verification path";
    else if (!attackable) gateFail = "no deployed/reachable target";
    const gatesPass = !gateFail;

    // ── feasibility (0-40) ──
    const machineShare = impacts.length ? impacts.filter((i) => i.machineCheckable).length / impacts.length : 0;
    const concreteScope = (rules.rules?.scopeIn?.length ?? 0) > 0 && (rules.rules?.target?.length ?? 0) > 0;
    const feasibility = 20 * machineShare + (verifiable ? 12 : 0) + (concreteScope ? 8 : 0);

    // ── time (0-20) ──
    const slaHeadroom = slaSec > 0 ? Math.min(slaSec / estSec, 1) : 1;
    const fastVerify = mode === "onchain-fork" || (mode === "company-attested" && (rules.verify?.bootSec ?? 20) <= 25);
    const time = 12 * slaHeadroom + (fastVerify ? 8 : 0);

    // ── economics (0-25) — normalised after the loop; keep raw EV now ──
    const confidence = Math.min(0.45 + 0.45 * machineShare + (concreteScope ? 0.1 : 0), 0.98);
    const ev = confidence * maxReward - totalBond;

    // ── liquidity fit (0-15) — Solana is cheaper, but only if it can settle ──
    const solOk = liq.solUsdc >= totalBond && solanaSettles;
    const chain = solOk ? "solana-devnet" : liq.evmUsdc >= totalBond ? "monad-testnet" : "none";
    const liquidityFit = chain === "solana-devnet" ? 15 : chain === "monad-testnet" ? 12 : 0;

    // ── trust: are the rules provably immutable? (on-chain hash == Swarm == ENS)
    // A hunter should only bond against rules that can't be rewritten after the
    // fact. The three-way proof is checked before committing to the pick.
    const ens = p.storage?.ens?.name ?? null;
    const swarmRef = p.storage?.swarm?.reference ?? null;
    const immutable = Boolean(rules.verified && swarmRef); // confirmed for the pick via /proof below

    rows.push({ slug: p.slug, name: p.name, total: 0, feasibility, time, economics: 0, liquidityFit,
      gatesPass, gateFail, estSec, slaSec, ev, maxReward, totalBond, chain, ens, swarmRef, immutable });
  }

  // normalise economics across the open set
  const maxEv = Math.max(...rows.map((r) => r.ev), 1);
  for (const r of rows) {
    r.economics = Math.max(0, 25 * (r.ev / maxEv));
    r.total = Math.round(r.feasibility + r.time + r.economics + r.liquidityFit);
  }
  rows.sort((a, b) => (b.gatesPass ? 1 : 0) - (a.gatesPass ? 1 : 0) || b.total - a.total);
  return { scored: rows, liq, solanaSettles };
}

const { scored, liq, solanaSettles } = await scoreAll();

console.log(`\nHunter liquidity: $${liq.evmUsdc.toFixed(2)} USDC (Monad) + $${liq.solUsdc.toFixed(2)} USDC (Solana)\n`);
console.log("Bounty".padEnd(20), "Score", "Feas", "Time", "Econ", "Liq", "SLA/est", "Gate");
for (const r of scored) {
  const within = r.slaSec === 0 || r.estSec < r.slaSec;
  console.log(
    r.slug.padEnd(20),
    String(r.total).padStart(4),
    r.feasibility.toFixed(0).padStart(4),
    r.time.toFixed(0).padStart(4),
    r.economics.toFixed(0).padStart(4),
    String(r.liquidityFit).padStart(3),
    `${within ? "ok" : "TIGHT"}`.padStart(6),
    r.gatesPass ? "pass" : `SKIP: ${r.gateFail}`,
  );
}

const eligible = scored.filter((r) => r.gatesPass && (r.slaSec === 0 || r.estSec < Math.min(r.slaSec, DEMO_WINDOW_SEC || r.slaSec)));
const pick = eligible[0] ?? null;
console.log();
let proof: any = null;
if (pick) {
  // Trust gate: confirm the rules are provably immutable before bonding.
  try { proof = await j(`/api/programs/${pick.slug}/proof`); } catch {}
  const immutable = proof?.allMatch === true;
  console.log(`▶ PICK: ${pick.slug} (score ${pick.total}) — pay the bond on ${pick.chain}.`);
  console.log(`   why: max reward $${pick.maxReward}, bonds $${pick.totalBond.toFixed(2)}, ` +
    `est proof ${pick.estSec}s within SLA ${pick.slaSec}s. Fast, provable, worth it.`);
  console.log(`   trust: rules ${immutable ? "PROVABLY IMMUTABLE ✓" : "not fully verified"} ` +
    `(on-chain hash == Swarm bytes${proof?.ens?.resolves ? " == ENS" : ""})`);
  if (pick.ens) console.log(`   ENS:   ${pick.ens}  →  🐝 ${pick.swarmRef ?? "(pending)"}`);
} else {
  console.log("▶ No bounty clears the gates yet (fund the wallet, or wait for a solvent program).");
}

// ── publish the decision to Swarm (censorship-resistant, auditable) ──────────
if (SWARM_ENABLED) {
  try {
    const decision = {
      kind: "monbounty.hunter-decision", version: 1,
      at: new Date().toISOString(), base: BASE,
      hunter: { evm: HUNTER_EVM || null, sol: HUNTER_SOL || null, liquidity: liq },
      criteria: "demo/hunter/CRITERIA.md",
      ranking: scored.map((r) => ({ slug: r.slug, total: r.total, feasibility: r.feasibility,
        time: r.time, economics: Math.round(r.economics), liquidityFit: r.liquidityFit,
        gate: r.gatesPass ? "pass" : r.gateFail, estSec: r.estSec, slaSec: r.slaSec, chain: r.chain,
        ens: r.ens, swarmRef: r.swarmRef })),
      pick: pick ? { slug: pick.slug, score: pick.total, chain: pick.chain, ens: pick.ens,
        swarmRef: pick.swarmRef, rulesImmutable: proof?.allMatch === true } : null,
    };
    const up = await swarmUpload(JSON.stringify(decision, null, 2),
      { filename: "hunter-decision.json", contentType: "application/json" });
    console.log(`\n🐝 decision stored on Swarm: ${up.reference}`);
    console.log(`   ${bzzUrl(up.reference)}`);
  } catch (e) {
    console.log("\n(swarm store failed:", String(e).slice(0, 100) + ")");
  }
}
process.exit(0);
