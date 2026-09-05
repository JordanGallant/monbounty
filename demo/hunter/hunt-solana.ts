// Drive the hunter through acme-pay-demo paying the x402 bonds on SOLANA DEVNET.
// The hunter signs SPL USDC transfers; PayAI's public facilitator is the fee-payer
// and lands them on-chain. Same bounty, same PoC — settled on Solana instead of Monad.
//
//   bun run demo/hunter/hunt-solana.ts
//
import { createKeyPairSignerFromBytes, createSolanaRpc, devnet } from "@solana/kit";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm";
import { toClientSvmSigner } from "@x402/svm";
import { solanaKeypairFromBase58, SOLANA_RPC, SOLANA_USDC, SOLANA_DEVNET_CAIP2, usdcBalance } from "../../lib/solana";
import { readFileSync } from "node:fs";

const BASE = process.env.MONBOUNTY_URL ?? "http://127.0.0.1:3044";
const PROGRAM = process.env.PROGRAM ?? "acme-pay-demo";
const maxUsd = Number(process.env.HUNTER_MAX_USD ?? 25);

const secret = JSON.parse(readFileSync("demo/hunter/.secrets/sol.json", "utf8")).secretKeyBase58;
const kp = solanaKeypairFromBase58(secret);
console.log(`hunter (solana) ${kp.publicKey.toBase58()}  USDC before: ${await usdcBalance(kp.publicKey.toBase58())}`);

const kitSigner = await createKeyPairSignerFromBytes(kp.secretKey);
const rpc = createSolanaRpc(devnet(SOLANA_RPC));
const svmSigner = toClientSvmSigner(kitSigner, rpc as any);

const client = x402Client.fromConfig({
  schemes: [{ network: SOLANA_DEVNET_CAIP2, client: new ExactSvmScheme(svmSigner) }],
  spendControls: {
    maxAmountPerPayment: `$${maxUsd}`,
    allowedAssets: [{ network: SOLANA_DEVNET_CAIP2, asset: SOLANA_USDC, maxAmountPerPayment: String(maxUsd * 1e6) }],
  },
  paymentRequirementsSelector: (_v: number, accepts: any[]) =>
    accepts.find((a) => a.network === SOLANA_DEVNET_CAIP2) ?? accepts[0],
});
client.onPaymentCreationFailure?.((ctx: any) => {
  console.log("‼ payment creation FAILED:", ctx?.error?.message ?? ctx?.error ?? JSON.stringify(ctx).slice(0, 200));
});
const payFetch = wrapFetchWithPayment(fetch, client);
const HUNTER = kp.publicKey.toBase58();
const q = `chain=solana&payer=${HUNTER}`;

const finding = {
  program: PROGRAM,
  title: "IDOR: /api/accounts/:id leaks another account's data (incl. service API key)",
  severity: "high",
  asset: "/api/accounts/:id",
  summary:
    "The accounts endpoint returns any account by id with no ownership check; /api/accounts/1001 " +
    "leaks the internal service account's live API key (broken object-level authorization).",
};

console.log("\n── submit report (pays bond on Solana devnet) ──");
const r1 = await payFetch(`${BASE}/api/v1/reports?program=${PROGRAM}&${q}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(finding),
});
const j1: any = await r1.json();
console.log("status", r1.status, JSON.stringify(j1).slice(0, 400));
if (!j1.id) { console.log("no report id — stopping"); process.exit(1); }

console.log("\n── submit PoC (pays the PoC gate on Solana devnet) ──");
const poc = JSON.stringify({ impact: "web-idor", requests: [{ method: "GET", path: "/api/accounts/1001" }] });
const r2 = await payFetch(`${BASE}/api/v1/reports/${j1.id}/poc?${q}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poc }),
});
console.log("status", r2.status, JSON.stringify(await r2.json()).slice(0, 300));

console.log(`\nUSDC after: ${await usdcBalance(kp.publicKey.toBase58())}`);
console.log(`report ${j1.id} queued — run the triager to verify + settle.`);
process.exit(0);
