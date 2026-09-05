// Hunt on Solana devnet paying the x402 bond from a CIRCLE developer-controlled
// wallet — the key is HSM-held, Circle signs the SPL transfer, no local key.
//
// The @x402/svm client emits a v0 transaction Circle won't sign, so we build the
// exact x402 exact-SVM transaction by hand (ComputeBudget ×2 + TransferChecked +
// Memo, fee-payer = PayAI), hand it to Circle to sign, and submit it in the
// PAYMENT-SIGNATURE header the middleware reads.
//
//   CIRCLE_SOL_WALLET_ID=… CIRCLE_SOL_ADDR=… bun run demo/hunter/hunt-circle-solana.ts
//
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddress, createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { randomBytes } from "node:crypto";
import { signSolanaTransaction } from "../../lib/circle";
import { SOLANA_USDC, usdcBalance, SOLANA_RPC } from "../../lib/solana";

const BASE = process.env.MONBOUNTY_URL ?? "http://127.0.0.1:3044";
const WALLET_ID = process.env.CIRCLE_SOL_WALLET_ID!;
const ADDR = process.env.CIRCLE_SOL_ADDR!;
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const conn = new Connection(SOLANA_RPC, "confirmed");
const mint = new PublicKey(SOLANA_USDC);

/** Pay one x402 gate: probe → build the exact tx → Circle-sign → resubmit. */
async function payGate(url: string, body: unknown): Promise<Response> {
  const probe = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (probe.status !== 402) return probe; // already paid / no gate
  const ch = JSON.parse(Buffer.from(probe.headers.get("payment-required")!, "base64").toString());
  const acc = ch.accepts.find((a: any) => a.network.startsWith("solana"));
  if (!acc) throw new Error("no solana accept in challenge");
  const resource = ch.resource;

  const payTo = new PublicKey(acc.payTo), feePayer = new PublicKey(acc.extra.feePayer);
  const cAta = await getAssociatedTokenAddress(mint, new PublicKey(ADDR));
  const pAta = await getAssociatedTokenAddress(mint, payTo);

  // Circle's devnet signer intermittently 400s ("API parameter invalid") on a
  // borderline-fresh blockhash; rebuild with a fresh one and retry a few times.
  let signedTransaction = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const freshBh = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const tx = new Transaction({ feePayer, recentBlockhash: freshBh }).add(
      // PayAI validates these exactly against the x402 exact-SVM scheme.
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      createTransferCheckedInstruction(cAta, mint, pAta, new PublicKey(ADDR), BigInt(acc.amount), 6, [], TOKEN_PROGRAM_ID),
      new TransactionInstruction({ keys: [], programId: MEMO, data: Buffer.from(randomBytes(16).toString("hex")) }),
    );
    const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    try { signedTransaction = (await signSolanaTransaction(WALLET_ID, raw)).signedTransaction; break; }
    catch (e) { if (attempt === 5) throw e; console.log(`  circle sign retry ${attempt}…`); await new Promise((r) => setTimeout(r, 800)); }
  }

  const paymentHeader = Buffer.from(JSON.stringify({
    x402Version: 2, payload: { transaction: signedTransaction },
    extensions: {}, resource, accepted: acc,
  })).toString("base64");

  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paymentHeader },
    body: JSON.stringify(body),
  });
}

console.log(`Circle Solana hunter ${ADDR}  USDC before: ${await usdcBalance(ADDR)}`);
const q = `chain=solana&payer=${ADDR}`;
const finding = {
  program: "acme-pay-demo",
  title: "IDOR via Circle Solana wallet: /api/accounts/:id leaks the service API key",
  severity: "high", asset: "/api/accounts/:id",
  summary: "The accounts endpoint returns any account by id with no ownership check; /api/accounts/1001 leaks the internal service account API key — bond paid from a Circle developer-controlled Solana wallet, no local key.",
};
console.log("\n── submit report (Circle-signed x402 on Solana) ──");
const r1 = await payGate(`${BASE}/api/v1/reports?program=acme-pay-demo&${q}`, finding);
const j1: any = await r1.json();
console.log("report:", r1.status, JSON.stringify(j1).slice(0, 200));
if (j1.id) {
  console.log("\n── submit PoC ──");
  const poc = JSON.stringify({ impact: "web-idor", requests: [{ method: "GET", path: "/api/accounts/1001" }] });
  const r2 = await payGate(`${BASE}/api/v1/reports/${j1.id}/poc?${q}`, { poc });
  console.log("poc:", r2.status, JSON.stringify(await r2.json()).slice(0, 160));
}
console.log(`\nUSDC after: ${await usdcBalance(ADDR)}`);
process.exit(0);
