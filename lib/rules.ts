// The rules a company commits to when it opens a bounty, and the hash that makes
// them immutable.
//
// `rulesHash` is stored on chain in SubmissionRegistry (bytes32) at createBounty.
// A hunter fetches the canonical rules from the API, recomputes the hash, and
// checks it against the on-chain value before spending a bond. If they match,
// the scope and payout table the hunter is reading are the exact ones the
// company can be held to — re-grading a finding later contradicts a published
// hash. keccak256 (not SHA-256) so the digest matches Solidity's native hash.
import { keccak256, toBytes } from "viem";
import { SEVERITIES, type PayoutTable, type Severity, validatePayouts, toTierArray } from "./severity";

export interface BountyRules {
  slug: string;
  name: string;
  /** What the hunter is attacking: a contract path, address, or URL. */
  target: string;
  scopeIn: string[];
  scopeOut: string[];
  payouts: PayoutTable;
  /** The submission price (step-1 bond, USD) the company set in onboarding. */
  bondUsd: number;
  /** Impact catalogue ids the program will pay for, by severity. */
  acceptedImpacts: string[];
  slaSeconds: number;
  /** Address that grades submissions on this bounty (the company's agent). */
  ruler: string;
}

/**
 * Deterministic serialization. Same rules in => same bytes out, regardless of
 * key order or whitespace, so the hunter and the server always agree on the
 * hash. Arrays are sorted; the payout table is emitted in fixed severity order.
 */
export function canonicalRules(r: BountyRules): string {
  const obj = {
    slug: r.slug.trim().toLowerCase(),
    name: r.name.trim(),
    target: r.target.trim(),
    scopeIn: [...r.scopeIn].map((s) => s.trim()).filter(Boolean).sort(),
    scopeOut: [...r.scopeOut].map((s) => s.trim()).filter(Boolean).sort(),
    payouts: SEVERITIES.reduce((o, s) => ((o[s] = r.payouts[s]), o), {} as Record<Severity, number>),
    bondUsd: Number(r.bondUsd) || 0,
    acceptedImpacts: [...r.acceptedImpacts].map((s) => s.trim()).filter(Boolean).sort(),
    slaSeconds: Math.floor(r.slaSeconds),
    ruler: r.ruler.trim().toLowerCase(),
  };
  return JSON.stringify(obj);
}

export function rulesHash(r: BountyRules): `0x${string}` {
  return keccak256(toBytes(canonicalRules(r)));
}

/** Everything the on-chain createBounty call needs, derived from the rules. */
export function bountyOnchainParams(r: BountyRules) {
  return {
    rulesHash: rulesHash(r),
    ruler: r.ruler,
    tiers: toTierArray(r.payouts).map((b) => b.toString()), // uint256[5], base units
    slaSeconds: Math.floor(r.slaSeconds),
  };
}

/** Reject a bounty a hunter could not trust: bad payouts, no scope, silly SLA. */
export function validateRules(r: BountyRules): { ok: true } | { ok: false; error: string } {
  if (!/^[a-z0-9-]{3,40}$/.test(r.slug.trim().toLowerCase()))
    return { ok: false, error: "slug must be 3-40 chars, [a-z0-9-]" };
  if (r.name.trim().length < 3) return { ok: false, error: "name too short" };
  if (r.target.trim().length < 3) return { ok: false, error: "target required" };
  if (r.scopeIn.filter((s) => s.trim()).length === 0)
    return { ok: false, error: "at least one in-scope item required" };
  const pv = validatePayouts(r.payouts);
  if (!pv.ok) return pv;
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.ruler)) return { ok: false, error: "ruler must be an address" };
  if (!(r.slaSeconds >= 3600)) return { ok: false, error: "slaSeconds must be >= 3600 (1h)" };
  return { ok: true };
}
