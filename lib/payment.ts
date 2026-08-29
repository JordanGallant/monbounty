// Helpers for reading who actually paid.
//
// The middleware verifies and settles before our handler runs, so by the time
// we see the request the X-PAYMENT header is known-good. We decode it purely to
// learn the payer address and bind the report to it — never to authorise.

export interface DecodedPayment {
  payer: string | null;
  network: string | null;
  scheme: string | null;
}

function b64json(raw: string): any | null {
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function decodePaymentHeader(header: string | undefined | null): DecodedPayment {
  const empty = { payer: null, network: null, scheme: null };
  if (!header) return empty;
  const outer = b64json(header);
  if (!outer) return empty;

  const p = outer.payload ?? {};
  // EIP-3009 (USDC transferWithAuthorization) vs Permit2 fallback.
  const payer: string | null =
    p?.authorization?.from ?? p?.permit2Authorization?.from ?? null;

  // x402 v2 puts the chosen requirement under `accepted`; older shape had it top-level.
  const acc = outer.accepted ?? {};
  return {
    payer: payer ? payer.toLowerCase() : null,
    network: outer.network ?? acc.network ?? null,
    scheme: outer.scheme ?? acc.scheme ?? null,
  };
}

/** The facilitator's settlement result, echoed back on X-PAYMENT-RESPONSE. */
export function decodeSettlementHeader(header: string | undefined | null): {
  txHash: string | null;
  success: boolean;
} {
  if (!header) return { txHash: null, success: false };
  const o = b64json(header);
  if (!o) return { txHash: null, success: false };
  return {
    txHash: o.transaction ?? o.txHash ?? null,
    success: o.success !== false,
  };
}

/**
 * Canonical hash of the substance of a report, used for duplicate detection.
 * Deliberately ignores the title and prose formatting: the cheapest way to
 * evade a naive duplicate check is to reword the summary, so we hash the
 * fields that describe the actual bug.
 */
export async function contentHash(input: {
  program: string;
  asset?: string | null;
  severity: string;
  summary: string;
}): Promise<string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const canonical = [
    norm(input.program),
    norm(input.asset ?? ""),
    norm(input.severity),
    norm(input.summary).split(" ").sort().join(" "),
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return "0x" + Buffer.from(digest).toString("hex");
}
