/**
 * Proves the fiat REFUND rail end-to-end with a REAL sandbox charge:
 *   create + confirm a real PaymentIntent (test card) → simulate the credited
 *   deposit that carries its payment_intent → refund part, then the rest → assert
 *   real Stripe refunds succeed, the ledger debits, and you can't over-refund.
 *
 *   bun run scripts/stripe-refund-test.ts
 */
import Stripe from "stripe";
import { db, ready, createDeposit, markDepositCredited, setDepositPaymentIntent } from "../lib/db";
import { creditDeposit, toAtomic, balanceUsd, userRef } from "../lib/ledger";
import { randomUUID } from "node:crypto";

const BASE = `http://localhost:${process.env.PORT ?? 3044}`;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
let fails = 0;
const check = (l: string, c: boolean, d = "") => { console.log(`${c ? "✓" : "✗"} ${l}${d ? "  " + d : ""}`); if (!c) fails++; };
async function call(method: string, path: string, o: { auth?: string; body?: any } = {}) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (o.auth) h.authorization = `Bearer ${o.auth}`;
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}

// 1. a real, refundable sandbox charge of $50
const pi = await stripe.paymentIntents.create({
  amount: 5000, currency: "usd", payment_method: "pm_card_visa", confirm: true,
  automatic_payment_methods: { enabled: true, allow_redirects: "never" },
});
check("real PaymentIntent succeeded", pi.status === "succeeded", pi.id);

// 2. register an account + simulate the credited $50 deposit carrying that PI
const reg = await call("POST", "/api/v1/accounts/register", { body: { kind: "company" } });
const { apiKey, accountId } = reg.body;
const owner = `account:${accountId}`;
await ready;
const depId = randomUUID();
await createDeposit(depId, owner, "stripe", toAtomic(50), `sess_${depId}`);
await creditDeposit(owner, toAtomic(50), "stripe", `stripe-deposit-${depId}`, "test deposit");
await markDepositCredited(depId, `stripe-deposit-${depId}`, null);
await setDepositPaymentIntent(depId, pi.id);
check("account funded from the deposit ($50)", (await balanceUsd(userRef(owner))) === 50);

// 3. refund $20 → real Stripe refund, balance → $30
const r1 = await call("POST", "/api/v1/refunds", { auth: apiKey, body: { amountUsd: 20 } });
check("partial refund $20 succeeds", r1.status === 200 && r1.body.refundedUsd === 20, r1.body.refunds?.[0]?.status ?? r1.body.error ?? "");
check("balance is $30 after $20 refund", r1.body.balanceUsd === 30, `$${r1.body.balanceUsd}`);

// 4. refund the rest (omit amount) → balance → $0
const r2 = await call("POST", "/api/v1/refunds", { auth: apiKey });
check("refund remaining ($30) succeeds", r2.status === 200 && r2.body.refundedUsd === 30, `$${r2.body.refundedUsd}`);
check("balance is $0 after full refund", r2.body.balanceUsd === 0, `$${r2.body.balanceUsd}`);

// 5. nothing left to refund
const r3 = await call("POST", "/api/v1/refunds", { auth: apiKey });
check("further refund is refused (nothing refundable)", r3.status === 422 && r3.body.error === "nothing_refundable");

// cleanup (tx_id-scoped so both legs of each posting go, nothing else)
await db.run("DELETE FROM deposits WHERE id = ?", [depId]);
await db.run("DELETE FROM ledger_entries WHERE tx_id = ? OR tx_id LIKE ?", [`stripe-deposit-${depId}`, `refund-${depId}-%`]);
await db.run("DELETE FROM ledger_accounts WHERE ref = ?", [userRef(owner)]);
await db.run("DELETE FROM account_credentials WHERE account_id = ?", [accountId]);
await db.run("DELETE FROM accounts WHERE id = ?", [accountId]);

console.log(fails === 0 ? "\n✓ fiat refund rail proven (real sandbox refunds)" : `\n✗ ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
