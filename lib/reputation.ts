import { db, type ReportRow } from "./db";

/**
 * A hunter's track record, derived from settled reports.
 *
 * This is the thing a bond is a poor substitute for. A bond makes every
 * submission cost the same regardless of who sends it, which taxes the good
 * researchers to price out the bots. Reputation lets the price fall for people
 * who have been right before — the bond stays high only for strangers.
 */
export interface Reputation {
  address: string;
  submitted: number;
  valid: number;
  duplicate: number;
  outOfScope: number;
  slop: number;
  pending: number;
  bondedUsd: number;
  refundedUsd: number;
  slashedUsd: number;
  paidOutUsd: number;
  signalRate: number | null; // valid / triaged
  tier: Tier;
  bondMultiplier: number;
  firstSeen: string | null;
  agentId: string | null;
}

export type Tier = "unknown" | "new" | "trusted" | "proven" | "penalised";

/**
 * Bond multipliers. Deliberately conservative: a proven hunter still posts a
 * bond, because "reputation zeroes the price" is exactly the property a
 * patient attacker farms — build history on cheap valid reports, then spray.
 */
const TIERS: Record<Tier, number> = {
  penalised: 2.0,
  unknown: 1.0,
  new: 1.0,
  trusted: 0.6,
  proven: 0.35,
};

export function tierFor(r: Omit<Reputation, "tier" | "bondMultiplier">): Tier {
  const triaged = r.valid + r.duplicate + r.outOfScope + r.slop;
  if (triaged === 0) return r.submitted === 0 ? "unknown" : "new";
  // Recent slop dominates: two junk reports undo a good history, otherwise the
  // discount becomes a subsidy for whoever farmed it first.
  if (r.slop >= 2 || (r.slop > 0 && r.valid === 0)) return "penalised";
  const rate = r.valid / triaged;
  if (r.valid >= 3 && rate >= 0.5) return "proven";
  if (r.valid >= 1 && rate >= 0.34) return "trusted";
  return "new";
}

export async function reputationFor(address: string): Promise<Reputation> {
  const a = address.toLowerCase();
  const rows = await db
    .query<ReportRow, [string]>("SELECT * FROM reports WHERE payer = ?")
    .all(a);
  const hunter = await db
    .query<{ agent_id: string | null; first_seen: string }, [string]>(
      "SELECT agent_id, first_seen FROM hunters WHERE address = ?",
    )
    .get(a);

  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const bonded = (r: ReportRow) => (r.bond_usd ?? 0) + (r.poc_bond_usd ?? 0);
  const refunded = rows.filter((r) => r.status === "valid" || r.status === "duplicate");
  const slashed = rows.filter((r) => r.status === "slop" || r.status === "out_of_scope");

  const base = {
    address: a,
    submitted: rows.length,
    valid: count("valid"),
    duplicate: count("duplicate"),
    outOfScope: count("out_of_scope"),
    slop: count("slop"),
    pending: count("awaiting_poc") + count("triaging"),
    bondedUsd: round(rows.reduce((s, r) => s + bonded(r), 0)),
    refundedUsd: round(refunded.reduce((s, r) => s + bonded(r), 0)),
    slashedUsd: round(slashed.reduce((s, r) => s + bonded(r), 0)),
    paidOutUsd: round(rows.reduce((s, r) => s + (r.payout_usd ?? 0), 0)),
    signalRate: null as number | null,
    firstSeen: hunter?.first_seen ?? null,
    agentId: hunter?.agent_id ?? null,
  };
  const triaged = base.valid + base.duplicate + base.outOfScope + base.slop;
  base.signalRate = triaged ? Number(((base.valid / triaged) * 100).toFixed(1)) : null;

  const tier = tierFor(base);
  return { ...base, tier, bondMultiplier: TIERS[tier] };
}

export async function leaderboard(limit = 25): Promise<Reputation[]> {
  const rows = await db
    .query<{ payer: string }, []>(
      "SELECT payer FROM reports GROUP BY payer ORDER BY COUNT(*) DESC LIMIT " + Number(limit),
    )
    .all();
  const reps = await Promise.all(rows.map((r) => reputationFor(r.payer)));
  return reps.sort((a, b) => b.valid - a.valid || b.paidOutUsd - a.paidOutUsd || a.slop - b.slop);
}

export async function touchHunter(address: string): Promise<void> {
  await db.run("INSERT OR IGNORE INTO hunters (address) VALUES (?)", [address.toLowerCase()]);
}

const round = (n: number) => Number(n.toFixed(3));


export type RiskDecision = "allow" | "risk" | "deny";

/**
 * The company-side gate: read a hunter's track record and decide.
 *   proven / trusted  -> allow   (established, discounted bond)
 *   unknown / new     -> risk    (no settled history — premium bond, watch closely)
 *   penalised         -> deny    (repeat slop — refuse the submission outright)
 * Portable across programs because it keys on the wallet, and mirrors the same
 * signal ERC-8004 reputation carries for the agent's on-chain identity.
 */
export async function assessHunter(address: string, includeOnchain = false): Promise<{
  decision: RiskDecision; tier: Tier; bondMultiplier: number; reason: string;
  valid: number; slop: number; signalRate: number | null; agentId: string | null;
  onchain: { agentId: string; count: number; value: number } | null;
}> {
  const r = await reputationFor(address);
  let decision: RiskDecision = "allow";
  let reason = "Established track record.";
  if (r.tier === "penalised") { decision = "deny"; reason = "Repeated invalid or slop submissions — denied."; }
  else if (r.tier === "unknown" || r.tier === "new") { decision = "risk"; reason = "No settled track record — risk premium applies, submissions watched."; }

  // ERC-8004 on-chain reputation, when the hunter has registered an identity and
  // the caller wants the (slower) chain read. It reinforces or overrides the
  // internal signal: strong negative on-chain feedback denies; a solid positive
  // history lifts a brand-new wallet out of the risk bucket.
  let onchain: { agentId: string; count: number; value: number } | null = null;
  if (includeOnchain && r.agentId) {
    try {
      const { readReputation } = await import("./erc8004");
      const rep = await readReputation(BigInt(r.agentId));
      if (rep) {
        onchain = { agentId: rep.agentId, count: rep.count, value: rep.value };
        if (rep.count >= 3 && rep.value < 0) { decision = "deny"; reason = `On-chain ERC-8004 feedback is negative (${rep.value} over ${rep.count}) — denied.`; }
        else if (decision === "risk" && rep.count >= 3 && rep.value > 0) { decision = "allow"; reason = `New here, but positive ERC-8004 track record (${rep.value} over ${rep.count}).`; }
      }
    } catch {}
  }
  return { decision, tier: r.tier, bondMultiplier: r.bondMultiplier, reason,
    valid: r.valid, slop: r.slop, signalRate: r.signalRate, agentId: r.agentId, onchain };
}
