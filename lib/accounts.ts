// The durable identity layer. An ACCOUNT owns the balance/rewards in the ledger;
// a wallet or an agent session is just a tool bound to it. This is what makes
// rewards survive a lost key or a fresh session (fomo.family-style): you recover
// the ACCOUNT, and the money follows — it was never tied to an ephemeral key.
//
// Credentials (all bearer, all stored ONLY as a SHA-256 hash):
//   api_key   — the runtime credential an agent carries into any session. Many
//               per account, each revocable. owner_ref = account:<id>.
//   recovery  — enrolled at signup and shown ONCE. If every api_key is lost, the
//               human presents this to mint a fresh one. Without it an account is
//               unrecoverable, so registration always returns one.
//
// Custodial by design (the account holds the balance) — same posture as the rest
// of the layer, gated upstream by CUSTODY_ENABLED. Self-custody / device-bound
// keys are an additive path later, not a rewrite of this.
import { db, ready } from "./db";
import { randomUUID } from "node:crypto";

export type AccountKind = "hunter" | "company";
export type CredType = "api_key" | "recovery";

const AK_PREFIX = "mb_ak_";
const RC_PREFIX = "mb_rc_";

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Buffer.from(d).toString("hex");
}
function genToken(prefix: string): string {
  return prefix + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

export interface AccountRow {
  id: string; kind: string; bound_withdraw_address: string | null;
  status: string; created_at: string;
}

/** The ledger owner_ref for an account. Everything money-side keys on this. */
export const accountRef = (id: string): string => `account:${id}`;

export async function createAccount(kind: AccountKind): Promise<string> {
  await ready;
  const id = `acct_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db.run("INSERT INTO accounts (id, kind) VALUES (?, ?)", [id, kind]);
  return id;
}

export async function getAccount(id: string): Promise<AccountRow | null> {
  await ready;
  return (await db.query<AccountRow, [string]>("SELECT * FROM accounts WHERE id = ?").get(id)) ?? null;
}

/** Mint a credential, store only its hash, return the raw token ONCE. */
export async function issueCredential(accountId: string, type: CredType, label?: string): Promise<string> {
  await ready;
  const raw = genToken(type === "api_key" ? AK_PREFIX : RC_PREFIX);
  await db.run(
    "INSERT INTO account_credentials (id, account_id, type, token_hash, label) VALUES (?,?,?,?,?)",
    [randomUUID(), accountId, type, await sha256hex(raw), label ?? null],
  );
  return raw;
}

/** Resolve an api_key to its account id (active only), stamping last-used. */
export async function resolveApiKey(raw: string): Promise<string | null> {
  if (!raw.startsWith(AK_PREFIX)) return null;
  await ready;
  const hash = await sha256hex(raw);
  const row = await db.query<{ id: string; account_id: string }, [string]>(
    "SELECT id, account_id FROM account_credentials WHERE type='api_key' AND revoked_at IS NULL AND token_hash = ?",
  ).get(hash);
  if (!row) return null;
  await db.run("UPDATE account_credentials SET last_used_at = datetime('now') WHERE id = ?", [row.id]);
  return row.account_id;
}

/** Verify a recovery code and return the account it recovers (active only). */
export async function verifyRecovery(raw: string): Promise<string | null> {
  if (!raw.startsWith(RC_PREFIX)) return null;
  await ready;
  const hash = await sha256hex(raw);
  const row = await db.query<{ account_id: string }, [string]>(
    "SELECT account_id FROM account_credentials WHERE type='recovery' AND revoked_at IS NULL AND token_hash = ?",
  ).get(hash);
  return row?.account_id ?? null;
}

/** Revoke every api_key on an account (used on recovery — old sessions die). */
export async function revokeApiKeys(accountId: string): Promise<void> {
  await ready;
  await db.run(
    "UPDATE account_credentials SET revoked_at = datetime('now') WHERE account_id = ? AND type='api_key' AND revoked_at IS NULL",
    [accountId]);
}

/** Rotate the single recovery code (consume the old, mint a new). */
export async function rotateRecovery(accountId: string): Promise<string> {
  await ready;
  await db.run(
    "UPDATE account_credentials SET revoked_at = datetime('now') WHERE account_id = ? AND type='recovery' AND revoked_at IS NULL",
    [accountId]);
  return issueCredential(accountId, "recovery");
}

/**
 * Bind (or change) the withdrawal address — the backstop. Once set, withdrawals
 * are restricted to it, so a leaked api_key cannot drain funds to an attacker's
 * address; changing it is a deliberate, separately-authorised action.
 */
export async function setBoundWithdrawAddress(accountId: string, address: string | null): Promise<void> {
  await ready;
  await db.run("UPDATE accounts SET bound_withdraw_address = ? WHERE id = ?", [address, accountId]);
}
