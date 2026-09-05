// x402 on Solana devnet — settled by a public facilitator (PayAI).
//
// The EVM side settles bonds through a remote facilitator (molandak). Solana
// works the same way: we point at PayAI's public facilitator, which is the
// fee-payer — it verifies the payment signature and lands the SPL USDC transfer
// on-chain. So monbounty needs NO Solana SOL of its own; PayAI pays the gas.
//
// This exports the pieces server.ts plugs into its resource server:
//   - `facilitator`  : an HTTPFacilitatorClient pointed at PayAI (verify/settle)
//   - `serverScheme` : the SVM Exact server scheme (builds the 402 challenge,
//                      embedding a recent blockhash)
//   - `svmPrice`     : builds a Solana USDC AssetAmount for the 402 challenge
//   - `feePayer`     : PayAI's devnet fee-payer (informational)

import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme as ExactSvmServerScheme } from "@x402/svm/exact/server";
import { SOLANA_ENABLED, SOLANA_RPC, SOLANA_USDC, SOLANA_USDC_DECIMALS, SOLANA_DEVNET_CAIP2 } from "./solana";

export { SOLANA_DEVNET_CAIP2 } from "./solana";

/** Public facilitator that settles Exact-SVM payments on Solana devnet. */
export const SOLANA_FACILITATOR_URL =
  (process.env.SOLANA_FACILITATOR_URL ?? "https://facilitator.payai.network").replace(/\/+$/, "");

/** A Solana USDC AssetAmount for an x402 `accepts` entry (mint + base units). */
export function svmPrice(usd: number) {
  return {
    asset: SOLANA_USDC,
    amount: Math.round(usd * 10 ** SOLANA_USDC_DECIMALS).toString(),
  };
}

export interface SvmRuntime {
  facilitator: HTTPFacilitatorClient;
  serverScheme: ExactSvmServerScheme;
  feePayer: string;
  network: string;
  facilitatorUrl: string;
}

let cached: SvmRuntime | null = null;

/**
 * Build the Solana x402 runtime (PayAI facilitator + server scheme), or null
 * when disabled / unreachable. Never throws — a Solana init failure must not
 * take down the working EVM flow.
 */
export async function initSvm(): Promise<SvmRuntime | null> {
  if (!SOLANA_ENABLED) return null;
  if (cached) return cached;
  try {
    const facilitator = new HTTPFacilitatorClient({ url: SOLANA_FACILITATOR_URL });
    const serverScheme = new ExactSvmServerScheme({ rpcUrl: SOLANA_RPC });

    // PayAI's devnet fee-payer, for display; the resource server pulls it into
    // the 402 challenge automatically via the facilitator's supported kinds.
    let feePayer = "";
    try {
      const sup = await (await fetch(`${SOLANA_FACILITATOR_URL}/supported`)).json();
      feePayer = sup?.kinds?.find((k: any) => k.network === SOLANA_DEVNET_CAIP2)?.extra?.feePayer ?? "";
    } catch { /* non-fatal */ }

    cached = { facilitator, serverScheme, feePayer, network: SOLANA_DEVNET_CAIP2, facilitatorUrl: SOLANA_FACILITATOR_URL };
    console.log(`[svm] x402 Solana devnet via PayAI facilitator ${SOLANA_FACILITATOR_URL} — fee-payer ${feePayer || "?"}`);
    return cached;
  } catch (e) {
    console.error("[svm] init failed (Solana x402 disabled for this boot):", String(e).slice(0, 200));
    return null;
  }
}
