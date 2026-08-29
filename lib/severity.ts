// Severity taxonomy, prices and machine-checkable impact proofs.
//
// Severity is the single most disputed thing in a bug bounty: it decides the
// payout, and today the party that pays is also the party that grades. This
// module makes the grading rubric an artifact — committed on chain inside the
// bounty's rulesHash — so a company cannot re-grade a finding after reading it.
//
// The taxonomy is impact-based, matching Immunefi's Vulnerability Severity
// Classification System (the de-facto standard for on-chain protocols) rather
// than a raw CVSS score. That choice matters: CVSS asks "how exploitable", the
// crypto standard asks "what does the protocol lose", and only the second maps
// to a payout. CVSS bands are carried alongside for the web/infra findings that
// do not fit an on-chain impact.

export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Contract tier index. The on-chain payout table is uint256[5] in this order. */
export const TIER_INDEX: Record<Severity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, informational: 4,
};

export type ImpactCategory = {
  id: string;
  severity: Severity;
  /** Immunefi-style impact statement. This is what a verdict must cite. */
  label: string;
  /**
   * The invariant a Class A proof-of-concept must break to establish this
   * impact. Present => the band is machine-checkable by executing the PoC.
   * Absent => the band rests on human/agent judgement.
   */
  invariant?: string;
};

/**
 * Impact catalogue. A verdict names an `id` from this list; the id determines
 * the severity, and the severity determines the payout tier. An agent grading a
 * report never picks a number — it picks an impact, and the number follows.
 */
export const IMPACTS: ImpactCategory[] = [
  // ── Critical ────────────────────────────────────────────────────────────
  { id: "theft-user-funds", severity: "critical",
    label: "Direct theft of user funds, at rest or in motion (excluding unclaimed yield)",
    invariant: "attacker USDC/native balance strictly increases and protocol or user balance strictly decreases by >= the same amount, in one transaction sequence" },
  { id: "permanent-freeze", severity: "critical",
    label: "Permanent freezing of funds",
    invariant: "every withdrawal path reverts for a holder with non-zero balance, and still reverts after an arbitrary number of blocks" },
  { id: "insolvency", severity: "critical",
    label: "Protocol insolvency",
    invariant: "sum of user claims exceeds contract-held assets" },
  { id: "governance-manipulation", severity: "critical",
    label: "Manipulation of governance voting result",
    invariant: "a proposal reaches an executable state without the configured quorum of legitimate voting power" },

  // ── High ────────────────────────────────────────────────────────────────
  { id: "theft-unclaimed-yield", severity: "high",
    label: "Theft of unclaimed yield or royalties",
    invariant: "attacker claims yield accrued to another account; principal balances unchanged" },
  { id: "temporary-freeze", severity: "high",
    label: "Temporary freezing of funds",
    invariant: "withdrawal reverts for a holder with non-zero balance but succeeds after a bounded delay" },

  // ── Medium ──────────────────────────────────────────────────────────────
  { id: "griefing", severity: "medium",
    label: "Griefing — damage to users or protocol with no profit to the attacker",
    invariant: "a user-facing operation is made to fail or cost materially more, while attacker balance does not increase" },
  { id: "contract-halt", severity: "medium",
    label: "Smart contract unable to operate due to lack of funds or block stuffing",
    invariant: "a core protocol function reverts under conditions an attacker can create and sustain" },
  { id: "unbounded-gas", severity: "medium",
    label: "Unbounded gas consumption / theft of gas",
    invariant: "gas used by a core function grows without bound under attacker-controlled input" },

  // ── Low ─────────────────────────────────────────────────────────────────
  { id: "degraded-returns", severity: "low",
    label: "Contract fails to deliver promised returns, but does not lose value" },
  { id: "web-low-impact", severity: "low",
    label: "Off-chain issue with limited impact (CVSS 0.1-3.9)" },

  // ── Web / application (off-chain) — graded by CVSS, not PoC-provable ───────
  { id: "web-rce", severity: "critical",
    label: "Remote code execution / arbitrary command execution on a server" },
  { id: "web-auth-bypass", severity: "critical",
    label: "Authentication bypass or full account takeover" },
  { id: "web-sqli", severity: "critical",
    label: "SQL / NoSQL injection exposing or altering data" },
  { id: "web-secret-exposure", severity: "critical",
    label: "Exposure of production secrets, keys, or credentials" },
  { id: "web-idor", severity: "high",
    label: "Broken access control / IDOR — acting on another tenant's data" },
  { id: "web-ssrf", severity: "high",
    label: "Server-side request forgery reaching internal services" },
  { id: "web-stored-xss", severity: "high",
    label: "Stored cross-site scripting affecting other users" },
  { id: "web-sensitive-data", severity: "high",
    label: "Exposure of sensitive user data (PII) without auth" },
  { id: "web-csrf", severity: "medium",
    label: "CSRF on a state-changing action" },
  { id: "web-reflected-xss", severity: "medium",
    label: "Reflected cross-site scripting" },
  { id: "web-rate-limit", severity: "medium",
    label: "Missing rate limiting enabling abuse or enumeration" },
  { id: "web-open-redirect", severity: "low",
    label: "Open redirect or minor information disclosure" },

  // ── Informational ───────────────────────────────────────────────────────
  { id: "informational", severity: "informational",
    label: "No security impact; code quality, gas or documentation" },
];

export const IMPACT_BY_ID = new Map(IMPACTS.map((i) => [i.id, i]));

/** Impacts whose band a PoC can establish by execution rather than argument. */
export function machineCheckable(): ImpactCategory[] {
  return IMPACTS.filter((i) => i.invariant);
}

// ── CVSS carry-over, for findings with no on-chain impact ──────────────────

export function severityFromCvss(score: number): Severity {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "informational";
}

export const CVSS_BANDS: Record<Severity, string> = {
  critical: "9.0-10.0", high: "7.0-8.9", medium: "4.0-6.9",
  low: "0.1-3.9", informational: "0.0",
};

// ── Payout tables ─────────────────────────────────────────────────────────

export type PayoutTable = Record<Severity, number>;

/**
 * Starting points a company agent proposes and a human then edits. These are
 * defaults for a demo, NOT researched market rates — the on-chain number is
 * whatever the human signs off, and that is the number that binds.
 *
 * `onchain` reflects the shape protocol bounties take (Immunefi's convention is
 * a percentage of funds at risk for Critical, with a floor); `web2` reflects the
 * far lower bands typical of application bounty programs. Verify against live
 * platform data before quoting either as a market rate.
 */
export const PRESET_PAYOUTS: Record<"onchain" | "web2", PayoutTable> = {
  onchain: { critical: 50000, high: 10000, medium: 5000, low: 1000, informational: 0 },
  web2:    { critical: 5000,  high: 1500,  medium: 500,  low: 150,  informational: 0 },
};

/** Critical is often "N% of funds at risk, floored and capped". */
export function criticalFromTvl(tvlUsd: number, pct = 0.1, floor = 50000, cap = 1_000_000): number {
  return Math.min(cap, Math.max(floor, Math.round(tvlUsd * pct)));
}

/** Payout table -> the uint256[5] the escrow contract stores, in USDC base units. */
export function toTierArray(p: PayoutTable): bigint[] {
  return SEVERITIES.map((s) => BigInt(Math.round(p[s] * 1e6)));
}

export function fromTierArray(tiers: readonly bigint[]): PayoutTable {
  const out = {} as PayoutTable;
  SEVERITIES.forEach((s, i) => { out[s] = Number(tiers[i] ?? 0n) / 1e6; });
  return out;
}

/** A payout table is only meaningful if it is monotonic in severity. */
export function validatePayouts(p: PayoutTable): { ok: true } | { ok: false; error: string } {
  for (const s of SEVERITIES) {
    const v = p[s];
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: `${s}: must be a non-negative number` };
  }
  for (let i = 1; i < SEVERITIES.length; i++) {
    const hi = SEVERITIES[i - 1]!, lo = SEVERITIES[i]!;
    if (p[lo] > p[hi]) return { ok: false, error: `${lo} ($${p[lo]}) pays more than ${hi} ($${p[hi]})` };
  }
  if (p.critical <= 0) return { ok: false, error: "critical must pay more than $0 or the bounty is not fundable" };
  return { ok: true };
}

/** Worst-case liability, used to check the escrowed pool actually covers it. */
export function maxLiability(p: PayoutTable, concurrentCriticals = 1): number {
  return p.critical * concurrentCriticals;
}
