/**
 * Shared x402 client for the hunter agent. Builds a signer from a private key
 * and a payment-capable fetch that pays across whichever Monad networks are
 * enabled, honouring a per-payment ceiling.
 *
 * Split out of hunter.ts so the standalone script and the agent tools sign
 * payments the exact same way.
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/core/client";
import { ENABLED, NETWORKS, type MonadNet, type NetKey } from "../lib/config";

export interface PayingClient {
  address: `0x${string}`;
  fetch: typeof fetch;
  /** Force payment onto one network regardless of what the server lists first. */
  preferred: MonadNet;
}

export function makePayingClient(privateKey: string, opts?: { network?: NetKey; maxUsd?: number }): PayingClient {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const maxUsd = opts?.maxUsd ?? Number(process.env.HUNTER_MAX_USD ?? 25);
  const preferred = opts?.network ? NETWORKS[opts.network] : ENABLED[0];

  const signer = {
    address: account.address,
    signTypedData: async (m: any) =>
      account.signTypedData({ domain: m.domain, types: m.types, primaryType: m.primaryType, message: m.message }),
  };

  const client = x402Client.fromConfig({
    schemes: ENABLED.map((n) => ({ network: n.id, client: new ExactEvmScheme(signer as any) })),
    spendControls: {
      // Monad USDC (esp. testnet) is not in @x402/evm's default asset table, so
      // it must be allow-listed explicitly, and the default $1 cap raised.
      maxAmountPerPayment: `$${maxUsd}`,
      allowedAssets: ENABLED.map((n) => ({
        network: n.id,
        asset: n.usdc,
        maxAmountPerPayment: String(maxUsd * 10 ** n.usdcDecimals),
      })),
    },
    // Of the networks the server offers, pay on the preferred one.
    paymentRequirementsSelector: (_v: number, accepts: any[]) =>
      accepts.find((a) => a.network === preferred.id) ?? accepts[0],
  });

  return {
    address: account.address,
    fetch: wrapFetchWithPayment(fetch, client),
    preferred,
  };
}

/**
 * A paying client whose EVM signature comes from a Circle developer-controlled
 * wallet (the key is HSM-held; Circle signs on request). Same x402 flow as the
 * local-key client, but signTypedData routes to Circle. Circle's API wants the
 * full EIP-712 structure, so we add the EIP712Domain type viem leaves implicit.
 */
export function makeCircleEvmClient(
  walletId: string, address: string, opts?: { network?: NetKey; maxUsd?: number },
): PayingClient {
  const maxUsd = opts?.maxUsd ?? Number(process.env.HUNTER_MAX_USD ?? 25);
  const preferred = opts?.network ? NETWORKS[opts.network] : ENABLED[0];
  const EIP712DOMAIN = [
    { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ];
  const signer = {
    address: address as `0x${string}`,
    signTypedData: async (m: any) => {
      const { signTypedData } = await import("../lib/circle");
      const types = m.types?.EIP712Domain ? m.types : { EIP712Domain: EIP712DOMAIN, ...m.types };
      return signTypedData(walletId, { domain: m.domain, types, primaryType: m.primaryType, message: m.message });
    },
  };
  const client = x402Client.fromConfig({
    schemes: ENABLED.map((n) => ({ network: n.id, client: new ExactEvmScheme(signer as any) })),
    spendControls: {
      maxAmountPerPayment: `$${maxUsd}`,
      allowedAssets: ENABLED.map((n) => ({ network: n.id, asset: n.usdc, maxAmountPerPayment: String(maxUsd * 10 ** n.usdcDecimals) })),
    },
    paymentRequirementsSelector: (_v: number, accepts: any[]) =>
      accepts.find((a) => a.network === preferred.id) ?? accepts[0],
  });
  return { address: address as `0x${string}`, fetch: wrapFetchWithPayment(fetch, client), preferred };
}

/** Decode the base64 PAYMENT-REQUIRED header the server sends on a rejected retry. */
export function readChallenge(res: Response): { reason: string; offers: { amount: string; asset: string; network: string; payTo: string }[] } | null {
  const h = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("payment-required");
  if (!h) return null;
  try {
    const d = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    return { reason: d.error ?? "unknown", offers: d.accepts ?? [] };
  } catch {
    return null;
  }
}
