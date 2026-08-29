/**
 * Demo hunter agent: finds nothing, but pays like a real one.
 *
 * This is the piece that makes the x402 story concrete — an autonomous agent
 * submits a report over plain HTTP, gets a 402, signs a USDC authorisation on
 * Monad, and retries. No account, no API key, no signup.
 *
 *   bun run agent/hunter.ts --program monad-escrow-demo
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/core/client";
import { NET, ENABLED, NETWORKS, PUBLIC_URL, type MonadNet } from "../lib/config";

const pk = process.env.HUNTER_PRIVATE_KEY;
if (!pk) throw new Error("HUNTER_PRIVATE_KEY not set in .env");

const account = privateKeyToAccount(pk as `0x${string}`);

const signer = {
  address: account.address,
  signTypedData: async (m: any) =>
    account.signTypedData({
      domain: m.domain,
      types: m.types,
      primaryType: m.primaryType,
      message: m.message,
    }),
};

// Two client-side defaults have to be overridden for Monad:
//  - spendControls allows only assets in @x402/evm's default table. Monad
//    TESTNET USDC is not in it, so payments are rejected before signing.
//  - the default per-payment cap is $1, which the PoC gate ($4) exceeds.
const MAX_USD = Number(process.env.HUNTER_MAX_USD ?? 25);
const atomic = (n: MonadNet) => String(MAX_USD * 10 ** n.usdcDecimals);

// Register a scheme per network so the agent can pay on whichever chain the
// server advertises, then pick with --network.
const client = x402Client.fromConfig({
  schemes: ENABLED.map((n) => ({
    network: n.id,
    client: new ExactEvmScheme(signer as any),
  })),
  spendControls: {
    maxAmountPerPayment: `$${MAX_USD}`,
    allowedAssets: ENABLED.map((n) => ({
      network: n.id,
      asset: n.usdc,
      maxAmountPerPayment: atomic(n),
    })),
  },
  // Of the networks the server offers, pay on the one we were asked to use.
  paymentRequirementsSelector: (_v: number, accepts: any[]) => {
    const want = pickNetwork().id;
    return accepts.find((a) => a.network === want) ?? accepts[0];
  },
});

/** Decode the server's PAYMENT-REQUIRED header so failures are readable. */
function explain(res: Response) {
  const h = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("payment-required");
  if (!h) return;
  try {
    const d = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    console.log("  reason:", d.error ?? "(none given)");
    for (const a of d.accepts ?? []) {
      console.log(`  offer:  ${a.amount} of ${a.asset} on ${a.network} -> ${a.payTo}`);
    }
  } catch { /* header not base64 JSON; nothing to add */ }
}

const pay = wrapFetchWithPayment(fetch, client);

const argvEarly = process.argv.slice(2);
function pickNetwork(): MonadNet {
  const i = argvEarly.indexOf("--network");
  const key = i >= 0 ? argvEarly[i + 1] : undefined;
  if (!key) return NET;
  const n = NETWORKS[key as keyof typeof NETWORKS];
  if (!n) throw new Error(`Unknown --network ${key}. Use mainnet or testnet.`);
  if (!ENABLED.some((e) => e.id === n.id)) {
    throw new Error(`--network ${key} is not in MONAD_NETWORKS (${ENABLED.map((e) => e.key).join(",")})`);
  }
  return n;
}

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const program = arg("program", "monad-escrow-demo");
const base = arg("base", PUBLIC_URL);

const finding = {
  title: arg("title", "Reentrancy in withdraw() allows draining the escrow"),
  severity: arg("severity", "critical"),
  asset: arg("asset", "contracts/SubmissionRegistry.sol"),
  summary: arg(
    "summary",
    "withdraw() transfers native value to msg.sender before zeroing the caller's " +
      "balance, so a contract with a payable fallback can re-enter and withdraw " +
      "repeatedly until the escrow is empty. The balance write happens after the " +
      "external call, which breaks checks-effects-interactions.",
  ),
};

console.log(`agent ${account.address} on ${pickNetwork().name} (${pickNetwork().id})`);
console.log(`submitting to ${base}/api/v1/reports?program=${program}`);

const r1 = await pay(`${base}/api/v1/reports?program=${program}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(finding),
});
const step1 = await r1.json();
console.log(`step 1 -> HTTP ${r1.status}`, step1);
// On a rejected retry the useful detail rides in the PAYMENT-REQUIRED header,
// not the body — without this the demo just prints "{}".
if (r1.status === 402) explain(r1);
if (!r1.ok || !step1.nextStep) process.exit(step1.status === "duplicate" ? 0 : 1);

console.log(`\nstep 2: paying PoC gate ($${step1.nextStep.priceUsd})`);
const r2 = await pay(step1.nextStep.url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    poc:
      "forge test --match-test testReentrancyDrain -vvv\n" +
      "Attacker deposits 1 ether, calls withdraw(), fallback re-enters withdraw() " +
      "3x, ends with 4 ether. See test/Reentrancy.t.sol.",
  }),
});
console.log(`step 2 -> HTTP ${r2.status}`, await r2.json());
console.log(`\nreport: ${base}/api/v1/reports/${step1.id}`);
