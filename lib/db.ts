// Postgres-backed (Supabase). The bun:sqlite surface is preserved by lib/pg.ts,
// so queries kept their SQLite SQL and only became async. `ready` runs the
// schema and seed exactly once; every helper and the server await it.
import { db } from "./pg";

export { db };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS programs (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL,
  bond_usd     REAL NOT NULL DEFAULT 1,
  reward_range TEXT,
  chain        TEXT,
  contact      TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  program       TEXT NOT NULL REFERENCES programs(slug),
  payer         TEXT NOT NULL,
  title         TEXT NOT NULL,
  severity      TEXT NOT NULL,
  summary       TEXT NOT NULL,
  asset         TEXT,
  content_hash  TEXT NOT NULL,
  -- step 1 (metadata bond)
  bond_usd      REAL NOT NULL,
  network       TEXT NOT NULL,
  settle_tx     TEXT,
  -- EIP-3009 nonce, used only to correlate the afterSettle hook (which fires
  -- after the handler returns) back to the row it paid for.
  settle_nonce  TEXT,
  -- step 2 (proof of concept) — null until the hunter pays the second gate
  poc           TEXT,
  poc_bond_usd  REAL,
  poc_settle_tx TEXT,
  poc_nonce     TEXT,
  poc_at        TEXT,
  -- triage
  status        TEXT NOT NULL DEFAULT 'awaiting_poc',
  verdict_note  TEXT,
  triaged_at    TEXT,
  refund_tx     TEXT,
  -- what the program actually paid for a valid finding, in USD
  payout_usd    REAL,
  payout_tx     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_program ON reports(program);
CREATE INDEX IF NOT EXISTS idx_reports_status  ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_hash    ON reports(content_hash);
CREATE INDEX IF NOT EXISTS idx_reports_payer   ON reports(payer);

-- ERC-8004 agent identity, one row per hunter address. agent_id is the token id
-- in an ERC-8004 IdentityRegistry; null for hunters who have not registered one.
-- The agent posts one of these when it cannot afford a bond; a human sees it
-- and tops up the wallet. status: open -> funded (agent confirmed) / cancelled.
CREATE TABLE IF NOT EXISTS funding_requests (
  id          TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  network     TEXT NOT NULL,
  need_usd    REAL NOT NULL,
  have_usd    REAL NOT NULL,
  reason      TEXT,
  program     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS hunters (
  address     TEXT PRIMARY KEY,
  agent_id    TEXT,
  registry    TEXT,
  network     TEXT,
  label       TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  feedback_tx TEXT
);

-- Wallets bounty402 provisions on an agent's behalf via Circle, so an agent
-- arriving with nothing can still get an address and start bonding. The
-- wallet_token is the bearer secret the agent presents to sign with it; only
-- its hash is stored, so a leak of this table cannot spend anyone's balance.
-- provider: circle. There is deliberately no withdraw path — same property the
-- local-key wallet has in agent/wallet.ts: an agent can bond, not cash out.
CREATE TABLE IF NOT EXISTS agent_wallets (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'circle',
  provider_id  TEXT NOT NULL,
  address      TEXT NOT NULL,
  network      TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  label        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_wallets_addr ON agent_wallets(address);

-- The overseer gate. Agent 2 rules and pays autonomously, but a payout is a
-- push transaction the treasury signs itself — there is no facilitator in the
-- middle and no way to unwind it. So the irreversible step, and only that step,
-- waits for a human. Everything before it stays unattended and merely visible.
-- state: pending -> approved | rejected.
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES reports(id),
  kind        TEXT NOT NULL,               -- refund | award
  amount_usd  REAL,
  recipient   TEXT,
  network     TEXT,
  rationale   TEXT,                        -- why the agent wants to do this
  state       TEXT NOT NULL DEFAULT 'pending',
  decided_by  TEXT,
  decided_at  TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approvals_state ON approvals(state, created_at);
`;

/** Runs schema + idempotent migrations + seed once, before any query. */
export const ready: Promise<void> = (async () => {
  await db.exec(SCHEMA);

  // Postgres does idempotent column adds natively — no table_info probe.
  await db.exec(
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS payout_usd REAL;
     ALTER TABLE reports ADD COLUMN IF NOT EXISTS payout_tx TEXT;
     ALTER TABLE reports ADD COLUMN IF NOT EXISTS content_swarm_ref  TEXT;
     ALTER TABLE reports ADD COLUMN IF NOT EXISTS evidence_swarm_ref TEXT;
     ALTER TABLE reports ADD COLUMN IF NOT EXISTS verdict_swarm_ref  TEXT;`,
  );

  // Company waitlist — prospective companies from the landing "Open a bounty" form.
  await db.exec(
    `CREATE TABLE IF NOT EXISTS waitlist (
       id         TEXT PRIMARY KEY,
       company    TEXT,
       email      TEXT NOT NULL,
       website    TEXT,
       message    TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );

  // Company side: a program IS a bounty. These columns carry the committed
  // rules, the on-chain hash, the escrowed pool and the SLA. Added idempotently
  // so an existing programs table upgrades in place.
  await db.exec(
    `ALTER TABLE programs ADD COLUMN IF NOT EXISTS target            TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS scope_in          TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS scope_out         TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS payouts           TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS accepted_impacts  TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS rules_hash        TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS sla_seconds       INTEGER;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS ruler             TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS tvl_usd           REAL;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS pool_committed_usd REAL NOT NULL DEFAULT 0;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS pool_funded_usd   REAL NOT NULL DEFAULT 0;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS created_by        TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS approval_status   TEXT NOT NULL DEFAULT 'approved';
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS approved_at       TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS approved_by       TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS verification_mode TEXT NOT NULL DEFAULT 'onchain-fork';
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS verify_recipe     TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS rules_swarm_ref   TEXT;
     ALTER TABLE programs ADD COLUMN IF NOT EXISTS ens_name          TEXT;`,
  );

  // Custodial balance layer: one internal double-entry ledger is the source of
  // truth for every user/program/platform balance. Amounts are integer USDC base
  // units (6 decimals) so there is no float drift; a balance is SUM(delta_atomic)
  // over an account. Fiat (Stripe) and crypto (on-chain/Ramp) are just deposit
  // rails that credit the same account. All idempotent — safe to run every boot.
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ledger_accounts (
       id         TEXT PRIMARY KEY,
       ref        TEXT NOT NULL,           -- e.g. user:0xabc, program:my-slug, platform:treasury
       kind       TEXT NOT NULL,           -- user | program | platform | external
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );
     CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_ref ON ledger_accounts(ref);

     CREATE TABLE IF NOT EXISTS ledger_entries (
       id           TEXT PRIMARY KEY,
       tx_id        TEXT NOT NULL,         -- groups the balanced legs of one movement
       account_id   TEXT NOT NULL REFERENCES ledger_accounts(id),
       delta_atomic BIGINT NOT NULL,       -- signed; the legs of a tx_id sum to zero
       memo         TEXT,
       created_at   TEXT NOT NULL DEFAULT (datetime('now'))
     );
     CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);
     CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_txleg ON ledger_entries(tx_id, account_id);

     -- A top-up in flight. rail: stripe | onchain | ramp. status: open -> credited
     -- (or expired). provider_ref is the Stripe session id or the on-chain match
     -- key; unique per rail so a replayed webhook / re-seen transfer is idempotent.
     CREATE TABLE IF NOT EXISTS deposits (
       id            TEXT PRIMARY KEY,
       owner_ref     TEXT NOT NULL,
       rail          TEXT NOT NULL,
       amount_atomic BIGINT NOT NULL,
       status        TEXT NOT NULL DEFAULT 'open',
       provider_ref  TEXT,
       tx_id         TEXT,                 -- the ledger tx that credited it, once done
       chain_tx      TEXT,
       created_at    TEXT NOT NULL DEFAULT (datetime('now')),
       settled_at    TEXT
     );
     CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider ON deposits(rail, provider_ref);
     CREATE INDEX IF NOT EXISTS idx_deposits_owner ON deposits(owner_ref);
     CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);

     -- The escape hatch back to self-custody: debit balance, treasury pays USDC
     -- to the user's own address. status: pending -> paid | failed.
     CREATE TABLE IF NOT EXISTS withdrawals (
       id            TEXT PRIMARY KEY,
       owner_ref     TEXT NOT NULL,
       amount_atomic BIGINT NOT NULL,
       to_address    TEXT NOT NULL,
       network       TEXT NOT NULL,
       status        TEXT NOT NULL DEFAULT 'pending',
       tx_id         TEXT,
       chain_tx      TEXT,
       error         TEXT,
       created_at    TEXT NOT NULL DEFAULT (datetime('now')),
       paid_at       TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_withdrawals_owner ON withdrawals(owner_ref);

     -- Durable identity: an account owns the balance/rewards (owner_ref =
     -- account:<id>). Rewards survive a lost key because they follow the account,
     -- not any credential. bound_withdraw_address restricts payouts once set.
     CREATE TABLE IF NOT EXISTS accounts (
       id                     TEXT PRIMARY KEY,
       kind                   TEXT NOT NULL,            -- hunter | company
       bound_withdraw_address TEXT,
       status                 TEXT NOT NULL DEFAULT 'active',
       created_at             TEXT NOT NULL DEFAULT (datetime('now'))
     );

     -- Bearer credentials, stored ONLY as a SHA-256 hash. type: api_key (runtime,
     -- many per account, revocable) | recovery (shown once at signup, mints a new
     -- api_key if all are lost).
     CREATE TABLE IF NOT EXISTS account_credentials (
       id           TEXT PRIMARY KEY,
       account_id   TEXT NOT NULL REFERENCES accounts(id),
       type         TEXT NOT NULL,
       token_hash   TEXT NOT NULL,
       label        TEXT,
       created_at   TEXT NOT NULL DEFAULT (datetime('now')),
       last_used_at TEXT,
       revoked_at   TEXT
     );
     CREATE UNIQUE INDEX IF NOT EXISTS idx_cred_hash ON account_credentials(token_hash);
     CREATE INDEX IF NOT EXISTS idx_cred_account ON account_credentials(account_id, type);`,
  );

  // Wallet hardening: link a Circle wallet to its owning account, give its
  // runtime token a spend cap + running total, and make it revocable. All
  // idempotent so an existing agent_wallets table upgrades in place.
  await db.exec(
    `ALTER TABLE agent_wallets ADD COLUMN IF NOT EXISTS account_id    TEXT;
     ALTER TABLE agent_wallets ADD COLUMN IF NOT EXISTS spend_cap_usd REAL;
     ALTER TABLE agent_wallets ADD COLUMN IF NOT EXISTS spent_usd     REAL NOT NULL DEFAULT 0;
     ALTER TABLE agent_wallets ADD COLUMN IF NOT EXISTS revoked_at    TEXT;
     ALTER TABLE accounts      ADD COLUMN IF NOT EXISTS identity_status TEXT;
     -- Refund rail: the Stripe payment to refund against, and how much of this
     -- deposit has already been refunded (partials allowed).
     ALTER TABLE deposits ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT;
     ALTER TABLE deposits ADD COLUMN IF NOT EXISTS refunded_atomic BIGINT NOT NULL DEFAULT 0;`,
  );

  // Seed a couple of Monad-flavoured programs so the demo has something to hit.
  const seeded = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM programs").get();
  if (!seeded || seeded.n === 0) {
    const ins = db.prepare(
      `INSERT INTO programs (slug, name, scope, bond_usd, reward_range, chain, contact)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    await ins.run(
      "monad-escrow-demo",
      "Monad Escrow (demo)",
      "SubmissionRegistry.sol and the escrow it guards. In scope: reentrancy, access control, accounting. Out of scope: gas golfing, centralisation risk.",
      1,
      "$500 - $25,000",
      "Monad Testnet",
      "security@example.invalid",
    );
    await ins.run(
      "x402-facilitator",
      "x402 Facilitator Integration",
      "Payment verification and settlement path. In scope: replay of EIP-3009 authorisations, nonce reuse, price manipulation on dynamic routes.",
      2,
      "$1,000 - $50,000",
      "Monad Testnet",
      "security@example.invalid",
    );
  }
})();

export type ReportStatus =
  | "awaiting_poc"
  | "triaging"
  | "valid"
  | "duplicate"
  | "out_of_scope"
  | "slop";

export interface ProgramRow {
  slug: string;
  name: string;
  scope: string;
  bond_usd: number;
  reward_range: string | null;
  chain: string | null;
  contact: string | null;
  active: number;
  created_at: string;
  // company side (null on the legacy seeded programs)
  target: string | null;
  scope_in: string | null;
  scope_out: string | null;
  payouts: string | null;
  accepted_impacts: string | null;
  rules_hash: string | null;
  sla_seconds: number | null;
  ruler: string | null;
  tvl_usd: number | null;
  pool_committed_usd: number;
  pool_funded_usd: number;
  created_by: string | null;
  approval_status: "pending" | "approved" | "rejected";
  approved_at: string | null;
  approved_by: string | null;
  verification_mode: "onchain-fork" | "company-attested";
  verify_recipe: string | null;
  // Swarm/ENS: the canonical rules are also stored on Swarm (censorship-resistant)
  // and can be pointed at by an ENS name's contenthash.
  rules_swarm_ref: string | null;
  ens_name: string | null;
}

export interface ReportRow {
  id: string;
  program: string;
  payer: string;
  title: string;
  severity: string;
  summary: string;
  asset: string | null;
  content_hash: string;
  bond_usd: number;
  network: string;
  settle_tx: string | null;
  settle_nonce: string | null;
  poc: string | null;
  poc_bond_usd: number | null;
  poc_settle_tx: string | null;
  poc_nonce: string | null;
  poc_at: string | null;
  status: ReportStatus;
  verdict_note: string | null;
  content_swarm_ref: string | null;
  evidence_swarm_ref: string | null;
  verdict_swarm_ref: string | null;
  triaged_at: string | null;
  refund_tx: string | null;
  payout_usd: number | null;
  payout_tx: string | null;
  created_at: string;
}

export interface FundingRequestRow {
  id: string;
  address: string;
  network: string;
  need_usd: number;
  have_usd: number;
  reason: string | null;
  program: string | null;
  status: "open" | "funded" | "cancelled";
  created_at: string;
  resolved_at: string | null;
}

export interface ApprovalRow {
  id: string;
  report_id: string;
  kind: "refund" | "award";
  amount_usd: number | null;
  recipient: string | null;
  network: string | null;
  rationale: string | null;
  state: "pending" | "approved" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
}

export interface AgentWalletRow {
  id: string;
  provider: string;
  provider_id: string;
  address: string;
  network: string;
  token_hash: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  account_id: string | null;
  spend_cap_usd: number | null;
  spent_usd: number;
  revoked_at: string | null;
}

/**
 * Look a provisioned wallet up by the bearer token the agent presents.
 * Compares hashes, never the token itself.
 */
export async function walletByToken(id: string, tokenHash: string): Promise<AgentWalletRow | null> {
  await ready;
  return (
    (await db
      .query<AgentWalletRow, [string, string]>(
        "SELECT * FROM agent_wallets WHERE id = ? AND token_hash = ? AND revoked_at IS NULL",
      )
      .get(id, tokenHash)) ?? null
  );
}

/** A wallet by id (any state) — for the account-authed rotate/payout endpoints. */
export async function getAgentWallet(id: string): Promise<AgentWalletRow | null> {
  await ready;
  return (await db.query<AgentWalletRow, [string]>("SELECT * FROM agent_wallets WHERE id = ?").get(id)) ?? null;
}
export async function revokeAgentWallet(id: string): Promise<void> {
  await ready;
  await db.run("UPDATE agent_wallets SET revoked_at = datetime('now') WHERE id = ?", [id]);
}
export async function addWalletSpend(id: string, usd: number): Promise<void> {
  await ready;
  await db.run("UPDATE agent_wallets SET spent_usd = spent_usd + ?, last_used_at = datetime('now') WHERE id = ?", [usd, id]);
}

export async function getProgram(slug: string): Promise<ProgramRow | null> {
  await ready;
  return (
    (await db
      .query<ProgramRow, [string]>("SELECT * FROM programs WHERE slug = ? AND active = 1 AND approval_status = 'approved'")
      .get(slug)) ?? null
  );
}

export async function listPrograms(): Promise<ProgramRow[]> {
  await ready;
  return db.query<ProgramRow, []>("SELECT * FROM programs WHERE active = 1 AND approval_status = 'approved' ORDER BY name").all();
}

/**
 * A bond only deters spam if the same finding cannot be resubmitted for free.
 * Matching on content hash within a program means a bot that reposts the same
 * LLM writeup pays every time and gets marked duplicate every time.
 */
export async function findDuplicate(program: string, contentHash: string): Promise<ReportRow | null> {
  await ready;
  return (
    (await db
      .query<ReportRow, [string, string]>(
        "SELECT * FROM reports WHERE program = ? AND content_hash = ? ORDER BY created_at LIMIT 1",
      )
      .get(program, contentHash)) ?? null
  );
}


// ── company side ────────────────────────────────────────────────────────────
import type { BountyRules } from "./rules";
import { rulesHash, canonicalRules } from "./rules";
import { swarmUpload, SWARM_ENABLED } from "./swarm";
import { programEnsName } from "./ens";

/** Any program by slug, including inactive — for the company/rules views. */
export async function getProgramRow(slug: string): Promise<ProgramRow | null> {
  await ready;
  return (
    (await db.query<ProgramRow, [string]>("SELECT * FROM programs WHERE slug = ?").get(slug)) ?? null
  );
}

/**
 * Create a bounty (a program) from committed rules. bond_usd is the hunter's
 * step-1 bond (kept small); the reward pool is separate and lives in
 * pool_committed_usd. rules_hash is stored so a hunter can verify it against
 * the canonical rules the API serves.
 */
export async function createBountyProgram(
  rules: BountyRules,
  extras: { bondUsd: number; tvlUsd?: number | null; contact?: string | null; createdBy?: string | null;
            verificationMode?: string; verifyRecipe?: unknown },
): Promise<{ slug: string; rulesHash: string; swarmRef: string | null; ensName: string }> {
  await ready;
  const slug = rules.slug.trim().toLowerCase();
  const hash = rulesHash(rules);
  const rewardRange = `$${rules.payouts.low.toLocaleString()} - $${rules.payouts.critical.toLocaleString()}`;
  await db.run(
    `INSERT INTO programs
       (slug, name, scope, bond_usd, reward_range, chain, contact, active,
        target, scope_in, scope_out, payouts, accepted_impacts, rules_hash,
        sla_seconds, ruler, tvl_usd, pool_committed_usd, created_by, approval_status,
        verification_mode, verify_recipe)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
    [
      slug, rules.name.trim(),
      [...rules.scopeIn, ...rules.scopeOut.map((s) => `OUT: ${s}`)].join("; "),
      extras.bondUsd, rewardRange, "Monad", extras.contact ?? null,
      rules.target.trim(),
      JSON.stringify(rules.scopeIn), JSON.stringify(rules.scopeOut),
      JSON.stringify(rules.payouts), JSON.stringify(rules.acceptedImpacts),
      hash, Math.floor(rules.slaSeconds), rules.ruler.trim().toLowerCase(),
      extras.tvlUsd ?? null, rules.payouts.critical, extras.createdBy ?? null,
      extras.verificationMode ?? "onchain-fork",
      extras.verifyRecipe ? JSON.stringify(extras.verifyRecipe) : null,
    ],
  );

  // Publish the canonical rules to Swarm so they are censorship-resistant and
  // retrievable by anyone: keccak256(bytes on Swarm) == the rules_hash we just
  // committed. Non-fatal — a program is still valid if Swarm is briefly down;
  // scripts/swarm-backfill.ts can push it later.
  let swarmRef: string | null = null;
  const ensName = programEnsName(slug);
  if (SWARM_ENABLED) {
    try {
      const up = await swarmUpload(canonicalRules(rules), {
        filename: `${slug}.rules.json`, contentType: "application/json",
      });
      swarmRef = up.reference;
      await db.run("UPDATE programs SET rules_swarm_ref = ?, ens_name = ? WHERE slug = ?",
        [swarmRef, ensName, slug]);
    } catch (e) {
      console.warn(`[swarm] rules upload failed for ${slug}:`, String(e).slice(0, 160));
      await db.run("UPDATE programs SET ens_name = ? WHERE slug = ?", [ensName, slug]);
    }
  }
  return { slug, rulesHash: hash, swarmRef, ensName };
}

/** Record a Swarm reference for a report artifact (content / evidence / verdict). */
export async function setReportSwarm(
  id: string, field: "content" | "evidence" | "verdict", reference: string,
): Promise<void> {
  await ready;
  const col = { content: "content_swarm_ref", evidence: "evidence_swarm_ref", verdict: "verdict_swarm_ref" }[field];
  await db.run(`UPDATE reports SET ${col} = ? WHERE id = ?`, [reference, id]);
}

/** Record reward-pool funding for a bounty (fiat or USDC). */
export async function recordProgramFunding(slug: string, addUsd: number): Promise<number> {
  await ready;
  await db.run("UPDATE programs SET pool_funded_usd = pool_funded_usd + ? WHERE slug = ?", [addUsd, slug]);
  const row = await db.query<{ p: number }, [string]>(
    "SELECT pool_funded_usd AS p FROM programs WHERE slug = ?",
  ).get(slug);
  return row?.p ?? 0;
}


/** Every program regardless of approval — for the admin review queue. */
export async function listAllPrograms(status?: string): Promise<ProgramRow[]> {
  await ready;
  if (status) return db.query<ProgramRow, [string]>(
    "SELECT * FROM programs WHERE approval_status = ? ORDER BY created_at DESC").all(status);
  return db.query<ProgramRow, []>("SELECT * FROM programs ORDER BY created_at DESC").all();
}

export async function setProgramApproval(slug: string, status: "approved" | "rejected", by: string): Promise<boolean> {
  await ready;
  const row = await getProgramRow(slug);
  if (!row) return false;
  await db.run("UPDATE programs SET approval_status = ?, approved_at = datetime('now'), approved_by = ? WHERE slug = ?",
    [status, by, slug]);
  return true;
}


/** Set/replace a bounty's verification mode + recipe (repo/build/run/assertions). */
export async function setProgramRecipe(
  slug: string, verificationMode: "onchain-fork" | "company-attested", verifyRecipe: unknown | null,
): Promise<boolean> {
  await ready;
  const row = await getProgramRow(slug);
  if (!row) return false;
  await db.run("UPDATE programs SET verification_mode = ?, verify_recipe = ? WHERE slug = ?",
    [verificationMode, verifyRecipe ? JSON.stringify(verifyRecipe) : null, slug]);
  return true;
}

/** Record where a program's canonical rules live on Swarm + its ENS name. */
export async function setProgramSwarm(
  slug: string, rulesSwarmRef: string | null, ensName?: string | null,
): Promise<boolean> {
  await ready;
  const row = await getProgramRow(slug);
  if (!row) return false;
  if (ensName === undefined) {
    await db.run("UPDATE programs SET rules_swarm_ref = ? WHERE slug = ?", [rulesSwarmRef, slug]);
  } else {
    await db.run("UPDATE programs SET rules_swarm_ref = ?, ens_name = ? WHERE slug = ?",
      [rulesSwarmRef, ensName, slug]);
  }
  return true;
}


// ── custodial balance: deposits & withdrawals ────────────────────────────────

export interface DepositRow {
  id: string; owner_ref: string; rail: string; amount_atomic: string;
  status: string; provider_ref: string | null; tx_id: string | null;
  chain_tx: string | null; created_at: string; settled_at: string | null;
  stripe_payment_intent: string | null; refunded_atomic: string;
}
export interface WithdrawalRow {
  id: string; owner_ref: string; amount_atomic: string; to_address: string;
  network: string; status: string; tx_id: string | null; chain_tx: string | null;
  error: string | null; created_at: string; paid_at: string | null;
}

export async function createDeposit(
  id: string, ownerRef: string, rail: "stripe" | "onchain" | "ramp",
  amountAtomic: bigint, providerRef: string,
): Promise<void> {
  await ready;
  await db.run(
    `INSERT INTO deposits (id, owner_ref, rail, amount_atomic, status, provider_ref)
     VALUES (?,?,?,?,'open',?)`,
    [id, ownerRef, rail, amountAtomic.toString(), providerRef],
  );
}

export async function getDeposit(id: string): Promise<DepositRow | null> {
  await ready;
  return (await db.query<DepositRow, [string]>("SELECT * FROM deposits WHERE id = ?").get(id)) ?? null;
}
export async function getDepositByProvider(rail: string, providerRef: string): Promise<DepositRow | null> {
  await ready;
  return (await db.query<DepositRow, [string, string]>(
    "SELECT * FROM deposits WHERE rail = ? AND provider_ref = ?").get(rail, providerRef)) ?? null;
}
export async function listOpenDeposits(rail: string): Promise<DepositRow[]> {
  await ready;
  return db.query<DepositRow, [string]>(
    "SELECT * FROM deposits WHERE rail = ? AND status = 'open' ORDER BY created_at").all(rail);
}
export async function markDepositCredited(id: string, txId: string, chainTx: string | null): Promise<void> {
  await ready;
  await db.run(
    "UPDATE deposits SET status = 'credited', tx_id = ?, chain_tx = ?, settled_at = datetime('now') WHERE id = ?",
    [txId, chainTx, id]);
}
export async function setDepositPaymentIntent(id: string, paymentIntent: string): Promise<void> {
  await ready;
  await db.run("UPDATE deposits SET stripe_payment_intent = ? WHERE id = ?", [paymentIntent, id]);
}

/** Credited Stripe deposits for an owner that still have refundable headroom, oldest first. */
export async function listRefundableStripeDeposits(ownerRef: string): Promise<DepositRow[]> {
  await ready;
  return db.query<DepositRow, [string]>(
    `SELECT * FROM deposits
       WHERE owner_ref = ? AND rail = 'stripe' AND status = 'credited'
         AND stripe_payment_intent IS NOT NULL
         AND refunded_atomic < amount_atomic
       ORDER BY created_at`,
  ).all(ownerRef);
}
export async function addDepositRefunded(id: string, addAtomic: bigint): Promise<void> {
  await ready;
  await db.run("UPDATE deposits SET refunded_atomic = refunded_atomic + ? WHERE id = ?", [addAtomic.toString(), id]);
}

export async function createWithdrawal(
  id: string, ownerRef: string, amountAtomic: bigint, toAddress: string, network: string,
): Promise<void> {
  await ready;
  await db.run(
    `INSERT INTO withdrawals (id, owner_ref, amount_atomic, to_address, network, status)
     VALUES (?,?,?,?,?,'pending')`,
    [id, ownerRef, amountAtomic.toString(), toAddress, network]);
}
export async function markWithdrawal(
  id: string, status: "paid" | "failed", fields: { txId?: string; chainTx?: string; error?: string },
): Promise<void> {
  await ready;
  await db.run(
    "UPDATE withdrawals SET status = ?, tx_id = ?, chain_tx = ?, error = ?, paid_at = datetime('now') WHERE id = ?",
    [status, fields.txId ?? null, fields.chainTx ?? null, fields.error ?? null, id]);
}
export async function listWithdrawals(ownerRef: string, limit = 25): Promise<WithdrawalRow[]> {
  await ready;
  return db.query<WithdrawalRow, [string, number]>(
    "SELECT * FROM withdrawals WHERE owner_ref = ? ORDER BY created_at DESC LIMIT ?").all(ownerRef, limit);
}
export async function listDeposits(ownerRef: string, limit = 25): Promise<DepositRow[]> {
  await ready;
  return db.query<DepositRow, [string, number]>(
    "SELECT * FROM deposits WHERE owner_ref = ? ORDER BY created_at DESC LIMIT ?").all(ownerRef, limit);
}
