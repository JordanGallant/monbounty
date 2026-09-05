// The internal double-entry ledger — the single source of truth for every
// balance in the custodial layer. Fiat (Stripe) and crypto (on-chain USDC /
// Ramp) are just deposit rails that credit the same user account; funding a
// pool, awarding a report and withdrawing are all balance moves.
//
// Amounts are ALWAYS integer USDC base units (6 decimals) — never floats — so
// there is no rounding drift. A balance is SUM(delta_atomic) over an account.
//
// Accounts partition into three kinds:
//   user:<ref>      liability — what we owe a hunter (0x…) or company (email)
//   program:<slug>  liability — a bounty's pooled reward
//   external:<rail> source/sink — money entering (stripe/onchain/ramp) or
//                   leaving (onchain_out) the system; carries a negative balance
//
// Because those are the only accounts and every movement sums to zero, the
// exact invariant is:  Σ(user:* + program:*)  ==  -Σ(external:*).
// "Backing" (treasury USDC on-chain + fiat float) is derived elsewhere, not a
// ledger account, and is what the solvency report compares those claims against.
import { db, ready } from "./db";
import { randomUUID } from "node:crypto";

const DECIMALS = 6;
export const toAtomic = (usd: number): bigint => BigInt(Math.round(usd * 10 ** DECIMALS));
export const fromAtomic = (atomic: bigint | number | string): number =>
  Number(BigInt(atomic)) / 10 ** DECIMALS;

export type AccountKind = "user" | "program" | "external";
export const userRef = (ref: string): string => `user:${ref.toLowerCase()}`;
export const programRef = (slug: string): string => `program:${slug.toLowerCase()}`;
export const externalRef = (rail: string): string => `external:${rail.toLowerCase()}`;

function kindOf(ref: string): AccountKind {
  const p = ref.split(":", 1)[0];
  if (p === "user" || p === "program" || p === "external") return p;
  throw new Error(`ledger: unknown account ref "${ref}"`);
}

/** Idempotent account create. The account id IS its ref (refs are unique). */
async function ensureAccount(ref: string): Promise<void> {
  await db.run(
    "INSERT OR IGNORE INTO ledger_accounts (id, ref, kind) VALUES (?, ?, ?)",
    [ref, ref, kindOf(ref)],
  );
}

export interface Leg { account: string; deltaAtomic: bigint }

/**
 * Post one balanced movement. The legs MUST sum to zero. Idempotent on txId:
 * a replayed post (same txId already present) is a no-op, so a re-delivered
 * Stripe webhook or a re-seen on-chain transfer cannot double-credit.
 */
export async function post(txId: string, memo: string, legs: Leg[]): Promise<{ posted: boolean }> {
  await ready;
  if (legs.length < 2) throw new Error("ledger: a movement needs at least two legs");
  const sum = legs.reduce((a, l) => a + l.deltaAtomic, 0n);
  if (sum !== 0n) throw new Error(`ledger: legs do not sum to zero (off by ${sum})`);

  const existing = await db.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE tx_id = ?",
  ).get(txId);
  if (existing && existing.n > 0) return { posted: false }; // already applied

  for (const l of legs) {
    await ensureAccount(l.account);
    await db.run(
      "INSERT OR IGNORE INTO ledger_entries (id, tx_id, account_id, delta_atomic, memo) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), txId, l.account, l.deltaAtomic.toString(), memo],
    );
  }
  return { posted: true };
}

/** Current balance of an account, in atomic base units. */
export async function balanceAtomic(ref: string): Promise<bigint> {
  await ready;
  const row = await db.query<{ bal: string | null }>(
    "SELECT COALESCE(SUM(delta_atomic), 0)::text AS bal FROM ledger_entries WHERE account_id = ?",
  ).get(ref);
  return BigInt(row?.bal ?? "0");
}

/** Convenience: a user/program balance as a USD number. */
export async function balanceUsd(ref: string): Promise<number> {
  return fromAtomic(await balanceAtomic(ref));
}

export interface HistoryRow { txId: string; deltaAtomic: string; memo: string | null; createdAt: string }
export async function history(ref: string, limit = 50): Promise<HistoryRow[]> {
  await ready;
  const rows = await db.query<{ tx_id: string; delta_atomic: string; memo: string | null; created_at: string }>(
    "SELECT tx_id, delta_atomic, memo, created_at FROM ledger_entries WHERE account_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(ref, limit);
  return rows.map((r) => ({ txId: r.tx_id, deltaAtomic: r.delta_atomic, memo: r.memo, createdAt: r.created_at }));
}

// ── typed movements (each is one balanced post) ──────────────────────────────

/** A deposit: money enters from a rail and becomes a user's spendable balance. */
export async function creditDeposit(
  owner: string, atomic: bigint, rail: "stripe" | "onchain" | "ramp", txId: string, memo = `${rail} deposit`,
): Promise<{ posted: boolean }> {
  return post(txId, memo, [
    { account: userRef(owner), deltaAtomic: atomic },
    { account: externalRef(rail), deltaAtomic: -atomic },
  ]);
}

/** Move a user's balance into a program's reward pool (company funding). */
export async function moveUserToProgram(
  owner: string, slug: string, atomic: bigint, txId: string, memo = `fund ${slug}`,
): Promise<{ posted: boolean }> {
  await assertCanSpend(userRef(owner), atomic);
  return post(txId, memo, [
    { account: userRef(owner), deltaAtomic: -atomic },
    { account: programRef(slug), deltaAtomic: atomic },
  ]);
}

/** Pay an award to a hunter's balance out of a program's pool. */
export async function payAwardFromProgram(
  slug: string, hunter: string, atomic: bigint, txId: string, memo = `award from ${slug}`,
): Promise<{ posted: boolean }> {
  return post(txId, memo, [
    { account: programRef(slug), deltaAtomic: -atomic },
    { account: userRef(hunter), deltaAtomic: atomic },
  ]);
}

/** Credit a hunter's balance directly (e.g. a bond refund not tied to a pool). */
export async function creditUser(
  owner: string, atomic: bigint, txId: string, memo: string,
): Promise<{ posted: boolean }> {
  return post(txId, memo, [
    { account: userRef(owner), deltaAtomic: atomic },
    { account: externalRef("platform"), deltaAtomic: -atomic },
  ]);
}

/** Debit a user's balance (e.g. bond a report from balance). */
export async function debitUser(
  owner: string, atomic: bigint, txId: string, memo: string, to: "platform" | string = "platform",
): Promise<{ posted: boolean }> {
  await assertCanSpend(userRef(owner), atomic);
  const sink = to.startsWith("program:") ? to : externalRef(to);
  return post(txId, memo, [
    { account: userRef(owner), deltaAtomic: -atomic },
    { account: sink, deltaAtomic: atomic },
  ]);
}

/** Withdraw: debit balance; the treasury then pays USDC out on-chain (leaves the system). */
export async function debitWithdrawal(
  owner: string, atomic: bigint, txId: string, memo = "withdrawal",
): Promise<{ posted: boolean }> {
  await assertCanSpend(userRef(owner), atomic);
  return post(txId, memo, [
    { account: userRef(owner), deltaAtomic: -atomic },
    { account: externalRef("onchain_out"), deltaAtomic: atomic },
  ]);
}

async function assertCanSpend(ref: string, atomic: bigint): Promise<void> {
  const bal = await balanceAtomic(ref);
  if (bal < atomic) throw new Error(`insufficient_balance: ${ref} has ${bal}, needs ${atomic}`);
}

// ── integrity / solvency ─────────────────────────────────────────────────────

/**
 * The exact ledger invariant plus derived backing. `claims` is what we owe
 * (users + programs); `externalNet` is what those claims must equal by
 * construction; `drift` must be zero. `backing` is what actually stands behind
 * the claims (live treasury USDC on-chain + fiat float), passed in by the caller
 * since it needs a chain read.
 */
export async function integrity(backingAtomic?: bigint): Promise<{
  claimsAtomic: bigint; externalNetAtomic: bigint; driftAtomic: bigint;
  claimsUsd: number; solvent: boolean | null; backingUsd: number | null;
}> {
  await ready;
  const claimsRow = await db.query<{ bal: string | null }>(
    `SELECT COALESCE(SUM(delta_atomic), 0)::text AS bal FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind IN ('user','program')`,
  ).get();
  const extRow = await db.query<{ bal: string | null }>(
    `SELECT COALESCE(SUM(delta_atomic), 0)::text AS bal FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind = 'external'`,
  ).get();
  const claims = BigInt(claimsRow?.bal ?? "0");
  const externalNet = -BigInt(extRow?.bal ?? "0");
  return {
    claimsAtomic: claims,
    externalNetAtomic: externalNet,
    driftAtomic: claims - externalNet,
    claimsUsd: fromAtomic(claims),
    solvent: backingAtomic === undefined ? null : backingAtomic >= claims,
    backingUsd: backingAtomic === undefined ? null : fromAtomic(backingAtomic),
  };
}
