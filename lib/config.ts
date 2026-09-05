// Monad x402 wiring. Values from docs.monad.xyz/guides/x402; the USDC EIP-712
// domain fields are verified on-chain against each contract below.
//
// Both networks can be live at once: a route advertises one `accepts` entry per
// enabled network and the client picks which to pay on. That is the whole
// reason x402 has an array there — a hunter on mainnet and an agent on testnet
// hit the same URL.

export type NetKey = "mainnet" | "testnet";
export type NetId = "eip155:143" | "eip155:10143";

export const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://x402-facilitator.molandak.org";

export interface MonadNet {
  key: NetKey;
  id: NetId;
  chainId: number;
  name: string;
  usdc: string;
  usdcName: string;
  usdcVersion: string;
  usdcDecimals: number;
  rpc: string;
  explorer: string;
  testnet: boolean;
}

export const NETWORKS: Record<NetKey, MonadNet> = {
  mainnet: {
    key: "mainnet",
    id: "eip155:143",
    chainId: 143,
    name: "Monad",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    usdcName: "USDC",
    usdcVersion: "2",
    usdcDecimals: 6,
    rpc: process.env.MONAD_MAINNET_RPC ?? "https://rpc.monad.xyz",
    explorer: "https://monadexplorer.com",
    testnet: false,
  },
  testnet: {
    key: "testnet",
    id: "eip155:10143",
    chainId: 10143,
    name: "Monad Testnet",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    usdcName: "USDC",
    usdcVersion: "2",
    usdcDecimals: 6,
    rpc: process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz",
    explorer: "https://testnet.monadexplorer.com",
    testnet: true,
  },
};

/** Which networks this deployment accepts. Order matters: first is the default. */
export const ENABLED: MonadNet[] = (process.env.MONAD_NETWORKS ?? "testnet,mainnet")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s): s is NetKey => s === "mainnet" || s === "testnet")
  .filter((k, i, a) => a.indexOf(k) === i)
  .map((k) => NETWORKS[k]);

if (ENABLED.length === 0) {
  throw new Error("MONAD_NETWORKS enabled no networks. Use e.g. 'testnet,mainnet'.");
}

/** Primary network — used for display and as the agent's default. */
export const NET = ENABLED[0];

export function netById(id: string | null | undefined): MonadNet | null {
  return ENABLED.find((n) => n.id === id) ?? null;
}

/** Dollars -> an explicit x402 AssetAmount in that network's USDC base units. */
export function usdPrice(usd: number, net: MonadNet) {
  return {
    asset: net.usdc,
    amount: Math.round(usd * 10 ** net.usdcDecimals).toString(),
    extra: { name: net.usdcName, version: net.usdcVersion },
  };
}

// Where bonds land. Same address on both chains (plain EOA), or set
// PAY_TO_ADDRESS_MAINNET / _TESTNET to use a different escrow per network.
const PAY_TO_BASE = process.env.PAY_TO_ADDRESS ?? "";
export function payToFor(net: MonadNet): string {
  const specific =
    net.key === "mainnet"
      ? process.env.PAY_TO_ADDRESS_MAINNET
      : process.env.PAY_TO_ADDRESS_TESTNET;
  return specific || PAY_TO_BASE;
}
export const PAY_TO = PAY_TO_BASE;

/**
 * The deployed SubmissionRegistry (the escrow) for a network, or "" if none is
 * configured. When SETTLEMENT_MODE=escrow the x402 payTo becomes this address,
 * bonds are recorded on it, and grade/settle replace the treasury's push
 * transfers — so a refund is enforceable rather than promised.
 */
export function registryFor(net: MonadNet): string {
  const v = net.key === "mainnet"
    ? process.env.SUBMISSION_REGISTRY_MAINNET
    : process.env.SUBMISSION_REGISTRY_TESTNET;
  return (v ?? "").trim();
}
export function hunterRepFor(net: MonadNet): string {
  const v = net.key === "mainnet"
    ? process.env.HUNTER_REPUTATION_MAINNET
    : process.env.HUNTER_REPUTATION_TESTNET;
  return (v ?? "").trim();
}
/** 'escrow' = settle on-chain via SubmissionRegistry; 'eoa' = custodial treasury. */
export const SETTLEMENT_MODE = (process.env.SETTLEMENT_MODE ?? "eoa").toLowerCase() === "escrow" ? "escrow" : "eoa";

/**
 * A Ramp Network checkout that lands USDC straight into `address` on Monad —
 * card, Apple Pay, Google Pay or bank transfer, no bridging.
 *
 * `MONAD_USDC` is verified against Ramp's own asset API as
 * 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, which is exactly NETWORKS.mainnet.usdc
 * below. So fiat buys the same contract our 402 demands.
 *
 * Mainnet only, and that is not a limitation we can engineer around: no onramp
 * sells testnet tokens. Returns null for a testnet address so callers show the
 * faucet instead of a checkout that cannot work.
 */
// Ramp Network host. Production by default; set to the demo/staging host
// (e.g. app.demo.rampnetwork.com) to exercise the flow in Ramp's sandbox.
// NOTE: off-ramp requires a production hostApiKey with off-ramping enabled for
// it — that's a Ramp Network partner-onboarding gate (KYB), not a bank balance.
export const RAMP_HOST = process.env.RAMP_HOST ?? "app.ramp.network";
// Default fiat for Ramp. EUR for a SEPA/Netherlands base; override per call or
// via RAMP_FIAT (e.g. USD, GBP).
export const RAMP_FIAT = process.env.RAMP_FIAT ?? "EUR";

export function rampUrl(address: string, net: MonadNet, usd?: number): string | null {
  if (net.testnet) return null;
  const q = new URLSearchParams({
    hostAppName: "bounty402",
    userAddress: address,
    defaultAsset: "MONAD_USDC",
    enabledCryptoAssets: "MONAD_USDC",
    fiatCurrency: RAMP_FIAT,
  });
  // Ramp enforces its own minimum; asking for less just shows an error to the
  // human, so round small bond top-ups up to something it will actually sell.
  if (usd && usd > 0) q.set("fiatValue", String(Math.max(Math.ceil(usd), 20)));
  const key = process.env.RAMP_HOST_API_KEY;
  if (key) q.set("hostApiKey", key);
  return `https://${RAMP_HOST}/?${q.toString()}`;
}

/**
 * The reverse: a Ramp OFF-ramp widget that sells USDC from `address` into the
 * human's bank/card. Ramp runs the per-user KYC in the widget and holds the
 * licensing, so the platform never operates identity checks or money
 * transmission for the cash-out — the human just opens this URL, connects the
 * wallet that holds the funds (their bound address, after a /payout), and sells.
 *
 * Mainnet only for the same reason as on-ramp (no fiat market for testnet
 * tokens) — returns null on testnet so callers don't surface a dead link.
 */
export function offrampUrl(address: string, net: MonadNet, usd?: number): string | null {
  if (net.testnet) return null;
  const q = new URLSearchParams({
    hostAppName: "bounty402",
    userAddress: address,
    enabledFlows: "OFFRAMP",
    defaultFlow: "OFFRAMP",
    offrampAsset: "MONAD_USDC",
    fiatCurrency: RAMP_FIAT,
  });
  if (usd && usd > 0) q.set("fiatValue", String(Math.max(Math.ceil(usd), 20)));
  const key = process.env.RAMP_HOST_API_KEY;
  if (key) q.set("hostApiKey", key);
  return `https://${RAMP_HOST}/?${q.toString()}`;
}

export const PORT = Number(process.env.PORT ?? 3044);
export const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

// Two-step gate. Step 1 buys a triage ticket for the metadata; step 2 costs
// more and is the one that actually kills spray-and-pray bots, because a
// bot that submitted 1,000 LLM writeups has to fund 1,000 second payments.
export const DEFAULT_BOND_USD = Number(process.env.DEFAULT_BOND_USD ?? 1);
export const POC_MULTIPLIER = Number(process.env.POC_MULTIPLIER ?? 4);

// Submitters must hold an ERC-8004 identity before they can bond. The company
// scores submissions against on-chain agent identities, so an unregistered
// wallet is blocked at intake and told to register first.
export const ERC8004_REQUIRED = (process.env.ERC8004_REQUIRED ?? "1") !== "0";

// ── custodial balance layer (fiat + crypto, testnet/sandbox only) ────────────
//
// A unified internal balance every user tops up by card (Stripe) or crypto
// (on-chain USDC / Ramp). Holding user balances and paying on their behalf is
// custodial money transmission, so the whole layer is OFF unless CUSTODY_ENABLED
// is explicitly set — it must never come on with a production Stripe key before
// the licensing question is answered. Ships testnet + Stripe sandbox only.
export const CUSTODY_ENABLED = process.env.CUSTODY_ENABLED === "1";

// Stripe (sandbox). Dormant unless both the secret key and webhook secret are
// set — same optional posture as Circle in lib/circle.ts.
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY ?? "";
// Enough to CREATE Checkout Sessions. Verifying webhooks additionally needs the
// signing secret (checked at verify time) — that arrives from `stripe listen`.
export const stripeConfigured = (): boolean => Boolean(STRIPE_SECRET_KEY);
export const stripeWebhookReady = (): boolean => Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET);

// Where crypto deposits (and Ramp onramp purchases) land so the watcher can
// credit the right balance. Defaults to the treasury address — the same wallet
// that later pays withdrawals out — so a deposit tops up the float it draws on.
export const PLATFORM_DEPOSIT_ADDRESS = (
  process.env.PLATFORM_DEPOSIT_ADDRESS || process.env.TREASURY_ADDRESS || ""
).toLowerCase();

// Deposit watcher tuning: how often to scan for incoming USDC, and how far back
// to look on each pass (blocks). Small window; Monad blocks are fast.
export const DEPOSIT_POLL_MS = Number(process.env.DEPOSIT_POLL_MS ?? 8000);
export const DEPOSIT_LOOKBACK_BLOCKS = BigInt(process.env.DEPOSIT_LOOKBACK_BLOCKS ?? 500);

export function assertConfig() {
  const missing: string[] = [];
  if (!ADMIN_TOKEN) missing.push("ADMIN_TOKEN");
  for (const n of ENABLED) {
    if (!payToFor(n)) missing.push(`PAY_TO_ADDRESS (or PAY_TO_ADDRESS_${n.key.toUpperCase()})`);
  }
  if (missing.length) {
    throw new Error(
      `Missing required env: ${[...new Set(missing)].join(", ")}. See .env.example.`,
    );
  }
}
