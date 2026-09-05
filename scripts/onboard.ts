/**
 * onboard.ts — one-time agent onboarding, AX-first.
 *
 * On first run it: registers an ACCOUNT (durable identity), provisions a Circle
 * HSM wallet UNDER that account (the key lives in Circle — only a revocable token
 * is ever exposed), and writes a PERSISTENT NOTE so the agent remembers its
 * wallet + the platform across sessions. On later runs it just reads the note
 * back (idempotent) — so a "new session" is a non-event.
 *
 *   bun run scripts/onboard.ts                 # first run: register + persist
 *   bun run scripts/onboard.ts --show          # print what's remembered
 *
 * The RECOVERY CODE is printed once and deliberately NOT written to the note —
 * keep it offline (or in a KMS). It re-mints an api key if the note is lost and
 * is the only thing that can change the withdrawal address.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { PUBLIC_URL } from "../lib/config";

const BASE = process.env.BOUNTY402_URL ?? PUBLIC_URL ?? "http://localhost:3044";
const NETWORK = process.env.MONBOUNTY_NETWORK ?? "testnet";
const NOTE_DIR = join(homedir(), ".monbounty");
const NOTE = join(NOTE_DIR, "agent.json");
const show = process.argv.includes("--show");

async function j(method: string, path: string, opts: { auth?: string; body?: any } = {}) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) h.authorization = `Bearer ${opts.auth}`;
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const body = await r.json().catch(() => ({} as any));
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(body)}`);
  return body;
}

// Already onboarded? Read the note and stop (idempotent across sessions).
if (existsSync(NOTE)) {
  const note = JSON.parse(readFileSync(NOTE, "utf8"));
  console.log(`already onboarded (from ${NOTE}):`);
  console.log(JSON.stringify({ ...note, walletToken: "•••stored•••" }, null, 2));
  console.log("\nUse note.apiKey as `Authorization: Bearer <apiKey>` and note.walletToken to sign bonds.");
  process.exit(0);
}
if (show) { console.log(`no note yet at ${NOTE} — run without --show to onboard.`); process.exit(0); }

console.log(`onboarding against ${BASE} (${NETWORK})…`);
const acct = await j("POST", "/api/v1/accounts/register", { body: { kind: "hunter" } });
const wallet = await j("POST", "/api/v1/wallets", { auth: acct.apiKey, body: { network: NETWORK, label: "primary" } });

const note = {
  platformUrl: BASE,
  network: NETWORK,
  accountId: acct.accountId,
  apiKey: acct.apiKey,            // runtime credential (revocable via recovery)
  walletId: wallet.walletId,
  address: wallet.address,
  walletToken: wallet.walletToken, // signs bonds only (whitelisted), revocable
  identityStatus: acct.identityStatus,
};
mkdirSync(NOTE_DIR, { recursive: true });
writeFileSync(NOTE, JSON.stringify(note, null, 2));
chmodSync(NOTE, 0o600);

console.log(`\n✓ onboarded. Persistent note written to ${NOTE} (chmod 600).`);
console.log(`  account ${acct.accountId}   wallet ${wallet.address}   identity ${acct.identityStatus}`);
console.log(`\n⚠  RECOVERY CODE (store OFFLINE — NOT in the note, NOT next to the api key):`);
console.log(`   ${acct.recoveryCode}`);
console.log(`\nNext: ask the human to fund ${wallet.address} with testnet USDC, then bond a report.`);
