/**
 * Proves the fiat rail end-to-end WITHOUT the Stripe CLI: create a real Checkout
 * Session (real sandbox API), then forge the `checkout.session.completed` event
 * Stripe would send and sign it with our webhook secret exactly the way Stripe's
 * servers do (generateTestHeaderString). If the signature verifies and the
 * balance is credited, the live webhook path is correct — swapping in a real
 * whsec + real Checkout changes nothing but where the event comes from.
 *
 *   bun run scripts/stripe-webhook-test.ts
 */
import { createHmac } from "node:crypto";

const BASE = `http://localhost:${process.env.PORT ?? 3044}`;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const WH = process.env.STRIPE_WEBHOOK_SECRET ?? "";
if (!WH) { console.error("STRIPE_WEBHOOK_SECRET not set"); process.exit(1); }

// Sign a payload exactly the way Stripe's servers (and CLI) do:
//   signedPayload = `${t}.${payload}` ; v1 = HMAC-SHA256(secret, signedPayload)
//   header = `t=${t},v1=${v1}`
function stripeSignature(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

const OWNER = `webhook-test-${Date.now()}@example.invalid`;
const AMOUNT = 50;
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) });

const before = (await (await fetch(`${BASE}/api/v1/balance?ownerRef=${encodeURIComponent(OWNER)}`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()).balanceUsd;
console.log(`owner ${OWNER}  balance before: $${before}`);

// 1. real Checkout Session (creates the deposit row)
const dep = await j(await fetch(`${BASE}/api/v1/deposits/stripe`, {
  method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: JSON.stringify({ ownerRef: OWNER, amountUsd: AMOUNT, kind: "company" }),
}));
console.log("checkout session created:", dep.body.depositId, dep.body.url ? "(real Stripe URL ✓)" : "(no url ✗)");

// 2. forge + sign the event Stripe would deliver on payment
const event = {
  id: `evt_test_${Date.now()}`,
  type: "checkout.session.completed",
  data: { object: { id: `cs_test_${Date.now()}`, object: "checkout.session", metadata: { depositId: dep.body.depositId, ownerRef: OWNER } } },
};
const payload = JSON.stringify(event);
const header = stripeSignature(payload, WH);

// 3. deliver it to the live webhook
const hook = await j(await fetch(`${BASE}/api/stripe/webhook`, {
  method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload,
}));
console.log("webhook response:", hook.status, JSON.stringify(hook.body));

// 4. deliver a SECOND time to prove idempotency
await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });

// 5. bad signature must be rejected
const bad = await j(await fetch(`${BASE}/api/stripe/webhook`, {
  method: "POST", headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" }, body: payload,
}));

const after = (await (await fetch(`${BASE}/api/v1/balance?ownerRef=${encodeURIComponent(OWNER)}`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()).balanceUsd;
console.log(`balance after: $${after}`);

let ok = true;
const assert = (l: string, c: boolean) => { console.log(`${c ? "✓" : "✗"} ${l}`); if (!c) ok = false; };
assert("webhook accepted (200)", hook.status === 200);
assert("balance credited by exactly the deposit amount (idempotent across 2 deliveries)", after - before === AMOUNT);
assert("bad signature rejected (400)", bad.status === 400);
console.log(ok ? "\n✓ fiat rail proven end-to-end" : "\n✗ failures");
process.exit(ok ? 0 : 1);
