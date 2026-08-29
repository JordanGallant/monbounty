/**
 * Circle developer-controlled wallets, scoped to Monad.
 *
 * Why this exists: an agent that walks up to bounty402 has no wallet and no
 * way to get one without a human doing key management first. Circle issues a
 * wallet over an API call, on Monad, holding the *same* USDC contract our 402
 * demands — verified: Circle's native USDC on Monad testnet is
 * 0x534b2f3A21130d7a60830c2Df862319e593943A3, which is exactly the asset in
 * lib/config.ts. So a Circle-held balance can pay our bonds directly, with no
 * bridge and no wrapped-token mismatch.
 *
 * Account type is EOA, deliberately. The x402 `exact` scheme settles an
 * EIP-3009 `transferWithAuthorization`, which the facilitator verifies by
 * recovering an ECDSA signature to the token holder. A smart-contract account
 * would sign via ERC-1271 and fail that recovery.
 *
 * Circle is optional. With CIRCLE_API_KEY unset every export here reports
 * unconfigured and the caller falls back to the local-key wallet in
 * agent/wallet.ts — a third-party signup must never be able to break the demo.
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { MonadNet } from "./config";

export type CircleChain = "MONAD" | "MONAD-TESTNET";

/** Circle's chain identifier for one of our configured Monad networks. */
export const circleChain = (net: MonadNet): CircleChain =>
  net.testnet ? "MONAD-TESTNET" : "MONAD";

const API_KEY = process.env.CIRCLE_API_KEY ?? "";
const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET ?? "";

export const circleConfigured = (): boolean => Boolean(API_KEY && ENTITY_SECRET);

let client: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;
function sdk() {
  if (!circleConfigured())
    throw new Error("circle_not_configured: set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET");
  // The SDK derives a fresh entity-secret ciphertext per request (Circle
  // rejects a replayed one), so the client is safe to keep as a singleton.
  if (!client) client = initiateDeveloperControlledWalletsClient({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
  return client;
}

export interface CircleWallet {
  walletId: string;
  address: string;
  chain: CircleChain;
}

/**
 * The wallet set every hunter wallet is created under. Circle requires one,
 * and it is created lazily on first use so deploying needs only the two
 * secrets. Pin it with CIRCLE_WALLET_SET_ID to survive a restart.
 */
let walletSetId: string | null = process.env.CIRCLE_WALLET_SET_ID || null;
export async function ensureWalletSet(): Promise<string> {
  if (walletSetId) return walletSetId;
  const r = await sdk().createWalletSet({ name: "bounty402 hunters" });
  const id = r.data?.walletSet?.id;
  if (!id) throw new Error("circle_wallet_set_failed");
  walletSetId = id;
  console.log(`[circle] created wallet set ${id} — pin it as CIRCLE_WALLET_SET_ID to reuse`);
  return id;
}

/** Provision one fresh hunter wallet on the given Monad network. */
export async function createWallet(net: MonadNet): Promise<CircleWallet> {
  const chain = circleChain(net);
  const r = await sdk().createWallets({
    accountType: "EOA",
    blockchains: [chain],
    count: 1,
    walletSetId: await ensureWalletSet(),
  });
  const w = r.data?.wallets?.[0];
  if (!w?.id || !w?.address) throw new Error("circle_wallet_create_failed");
  return { walletId: w.id, address: w.address.toLowerCase(), chain };
}

/**
 * Sign EIP-712 typed data. This is the whole reason Circle can pay our 402:
 * the facilitator broadcasts, so Circle never needs to be a Monad RPC
 * provider — it only needs to produce this signature.
 *
 * `data` must be a JSON *string*, not an object; the API rejects an object.
 */
export async function signTypedData(walletId: string, typedData: unknown): Promise<`0x${string}`> {
  const r = await sdk().signTypedData({ walletId, data: JSON.stringify(typedData) });
  const sig = r.data?.signature;
  if (!sig) throw new Error("circle_sign_failed");
  return sig as `0x${string}`;
}
