// The fiat -> USDC conversion seam.
//
// When a card deposit settles, the platform owes USDC it must actually hold to
// stay solvent. On testnet there is nothing to do: the treasury is faucet-funded
// testnet USDC and the fiat side is pure accounting owed against that float. In
// production this is where an exchange withdrawal or Circle Mint issuance slots
// in (once volume qualifies for Circle Mint primary issuance).
//
// Kept as its own module so the ledger and deposit routes never hard-code the
// assumption "fiat already equals USDC" — swapping this out is the only change
// needed to make conversion real.
import { CUSTODY_ENABLED } from "./config";

export interface ConversionResult {
  converted: boolean;
  provider: "noop" | "exchange" | "circle-mint";
  detail: string;
}

/**
 * Convert `amountUsd` of received fiat into treasury USDC. Testnet impl is a
 * no-op that just records intent. Returning `converted:false` is not an error —
 * it means the fiat is held as an accounting claim against the existing float.
 */
export async function fiatToUsdc(amountUsd: number): Promise<ConversionResult> {
  // Prod wiring goes here (guard on !net.testnet and a configured provider key).
  return {
    converted: false,
    provider: "noop",
    detail: CUSTODY_ENABLED
      ? `testnet: $${amountUsd.toFixed(2)} held as fiat float against the treasury USDC balance (no real conversion)`
      : "custody disabled",
  };
}
