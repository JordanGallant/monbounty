// Stripe (sandbox) — the fiat deposit rail. A Checkout Session takes a card /
// bank payment; the webhook is what actually credits the internal ledger, so a
// deposit is only real once Stripe tells us the money settled.
//
// Optional, exactly like lib/circle.ts: with the keys unset every export reports
// unconfigured and the deposit routes 501, so the rest of the app runs without a
// Stripe account. Test keys + sandbox only — the whole layer is gated behind
// CUSTODY_ENABLED upstream.
import Stripe from "stripe";
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, stripeConfigured, PUBLIC_URL } from "./config";

let client: Stripe | null = null;
function sdk(): Stripe {
  if (!stripeConfigured()) throw new Error("stripe_not_configured: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET");
  if (!client) client = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" as any });
  return client;
}

export { stripeConfigured };

export interface CheckoutInput {
  ownerRef: string;      // who the balance belongs to (email or 0x…)
  depositId: string;     // our deposits row id, echoed back on the webhook
  amountUsd: number;
  kind: "hunter" | "company";
}

/**
 * A hosted Checkout Session for a one-off top-up. metadata carries our depositId
 * + ownerRef so the webhook can find the row to credit. Amount is charged in
 * whole USD cents.
 */
export async function createCheckoutSession(
  input: CheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  const cents = Math.round(input.amountUsd * 100);
  if (!(cents > 0)) throw new Error("bad_amount");
  const session = await sdk().checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: cents,
        product_data: { name: `monbounty balance top-up ($${input.amountUsd.toFixed(2)})` },
      },
    }],
    metadata: { depositId: input.depositId, ownerRef: input.ownerRef, kind: input.kind },
    // Sent to the buyer after pay/cancel. Portal reads ?deposit= to poll the balance.
    success_url: `${PUBLIC_URL}/dashboard?deposit=${encodeURIComponent(input.depositId)}&status=success`,
    cancel_url: `${PUBLIC_URL}/dashboard?deposit=${encodeURIComponent(input.depositId)}&status=cancel`,
  });
  if (!session.url) throw new Error("stripe_no_checkout_url");
  return { url: session.url, sessionId: session.id };
}

/**
 * Refund `amountUsd` against a prior payment (the deposit's payment_intent). The
 * money goes back to the ORIGINAL card automatically — Stripe won't let us
 * redirect it — which is exactly why the refund rail is safe.
 */
export async function createRefund(paymentIntent: string, amountUsd: number): Promise<{ id: string; status: string | null }> {
  const cents = Math.round(amountUsd * 100);
  if (!(cents > 0)) throw new Error("bad_amount");
  const r = await sdk().refunds.create({ payment_intent: paymentIntent, amount: cents });
  return { id: r.id, status: r.status };
}

/** Verify a webhook payload against the signing secret and return the event. */
export async function verifyWebhook(rawBody: string, signature: string): Promise<Stripe.Event> {
  if (!STRIPE_WEBHOOK_SECRET) throw new Error("webhook_secret_not_set");
  // constructEventAsync uses WebCrypto — works under Bun without node:crypto shims.
  return sdk().webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}
