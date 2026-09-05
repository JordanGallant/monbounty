// Whitelist for what a Circle wallet's runtime token is allowed to sign.
//
// The sign endpoint mediates every signature a managed wallet produces, so it is
// the choke point that turns a stolen walletToken from "drain the wallet" into
// "at worst, bond a report to our own intake." We ONLY sign an EIP-3009
// authorization that pays a bond to one of our own sinks (payTo / the escrow
// registry) — never an arbitrary transfer to an attacker's address.
import { NETWORKS, payToFor, registryFor, netById, type MonadNet } from "./config";

export type GuardResult = { ok: true; net: MonadNet; valueUsd: number } | { ok: false; error: string };

const norm = (s: unknown) => String(s ?? "").toLowerCase();

/**
 * Assert a typed-data payload is a legitimate bond authorization for `wallet`.
 * Returns the network + the USD value being authorized (for the spend cap), or
 * an error string. Rejects anything that is not an EIP-3009 transfer to one of
 * our own bond sinks, from this exact wallet, on this wallet's network's USDC.
 */
export function assertBondAuthorization(
  typedData: any,
  wallet: { address: string; network: string },
): GuardResult {
  const net = netById(wallet.network) ?? NETWORKS.testnet;
  const primary = String(typedData?.primaryType ?? "");
  if (primary !== "TransferWithAuthorization" && primary !== "ReceiveWithAuthorization")
    return { ok: false, error: `primaryType_not_allowed:${primary || "none"}` };

  const domain = typedData?.domain ?? {};
  if (norm(domain.verifyingContract) !== norm(net.usdc))
    return { ok: false, error: "wrong_token_contract" };

  const m = typedData?.message ?? {};
  if (norm(m.from) !== norm(wallet.address))
    return { ok: false, error: "from_not_self" };

  // Only our own bond sinks are permitted destinations.
  const sinks = [payToFor(net), registryFor(net)].map(norm).filter(Boolean);
  if (!sinks.includes(norm(m.to)))
    return { ok: false, error: "destination_not_whitelisted" };

  // value is USDC base units (6 dp). Reject a missing/garbage value.
  let value: bigint;
  try { value = BigInt(m.value ?? m.amount); } catch { return { ok: false, error: "bad_value" }; }
  if (value <= 0n) return { ok: false, error: "bad_value" };
  const valueUsd = Number(value) / 10 ** net.usdcDecimals;

  return { ok: true, net, valueUsd };
}
