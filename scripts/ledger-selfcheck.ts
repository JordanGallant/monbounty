/**
 * Ledger invariant self-check. Exercises a full deposit -> fund -> award ->
 * withdraw sequence against scratch accounts and asserts:
 *   1. every movement is zero-sum (enforced by post())
 *   2. no user/program balance ever goes negative (enforced by assertCanSpend)
 *   3. balances land where expected
 *   4. the ledger integrity invariant holds: claims == -Σexternal, drift == 0
 *   5. posting is idempotent (a replayed txId does not double-apply)
 *
 *   bun run scripts/ledger-selfcheck.ts
 *
 * Uses a unique scratch owner/program per run so it is safe against a live DB.
 */
import {
  toAtomic, fromAtomic, balanceUsd, creditDeposit, moveUserToProgram,
  payAwardFromProgram, debitWithdrawal, integrity, userRef, programRef,
} from "../lib/ledger";

const tag = `selfcheck-${Date.now()}`;
const OWNER = `0xhunter-${tag}`;
const COMPANY = `company-${tag}@example.invalid`;
const SLUG = `prog-${tag}`;

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!cond) failures++;
}
async function expectThrow(label: string, fn: () => Promise<unknown>) {
  try { await fn(); check(label, false, "(expected throw, got success)"); }
  catch { check(label, true); }
}

console.log(`ledger self-check  tag=${tag}\n`);

// 1. company deposits $100 by card, hunter deposits $10 of crypto
await creditDeposit(COMPANY, toAtomic(100), "stripe", `${tag}-dep-company`);
await creditDeposit(OWNER, toAtomic(10), "onchain", `${tag}-dep-hunter`);
check("company balance = 100", (await balanceUsd(userRef(COMPANY))) === 100);
check("hunter balance = 10", (await balanceUsd(userRef(OWNER))) === 10);

// 2. company funds a pool with $60 of its balance
await moveUserToProgram(COMPANY, SLUG, toAtomic(60), `${tag}-fund`);
check("company balance = 40 after funding", (await balanceUsd(userRef(COMPANY))) === 40);
check("program pool = 60", (await balanceUsd(programRef(SLUG))) === 60);

// 3. over-spend is refused (company only has 40 left)
await expectThrow("over-fund refused (no negative balance)",
  () => moveUserToProgram(COMPANY, SLUG, toAtomic(999), `${tag}-overfund`));

// 4. hunter is awarded $25 from the pool
await payAwardFromProgram(SLUG, OWNER, toAtomic(25), `${tag}-award`);
check("hunter balance = 35 after award", (await balanceUsd(userRef(OWNER))) === 35);
check("program pool = 35 after award", (await balanceUsd(programRef(SLUG))) === 35);

// 5. hunter withdraws $30 to their own wallet
await debitWithdrawal(OWNER, toAtomic(30), `${tag}-wd`);
check("hunter balance = 5 after withdrawal", (await balanceUsd(userRef(OWNER))) === 5);

// 6. withdrawal beyond balance refused
await expectThrow("over-withdraw refused",
  () => debitWithdrawal(OWNER, toAtomic(999), `${tag}-overwd`));

// 7. idempotency: replaying a posted txId is a no-op
const before = await balanceUsd(userRef(OWNER));
const rep = await creditDeposit(OWNER, toAtomic(10), "onchain", `${tag}-dep-hunter`);
check("replayed deposit did not re-apply", rep.posted === false && (await balanceUsd(userRef(OWNER))) === before);

// 8. global integrity invariant
const integ = await integrity();
check("integrity drift == 0", integ.driftAtomic === 0n,
  `claims=${fromAtomic(integ.claimsAtomic)} externalNet=${fromAtomic(integ.externalNetAtomic)}`);

console.log(`\n${failures === 0 ? "✓ all checks passed" : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
