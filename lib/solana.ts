// Solana devnet rail — wallet creation, identity, and USDC (SPL) balances.
//
// Parity with the EVM side: a hunter or company can spin up a Solana wallet, be
// identified by its pubkey, and hold/settle USDC on Solana devnet. The x402
// payment gate for Solana lives in lib/x402-svm.ts (it uses @solana/kit); this
// module uses @solana/web3.js + spl-token for the everyday wallet operations.

import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

export const SOLANA_ENABLED = process.env.SOLANA_ENABLED === "1";
export const SOLANA_RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

/** Circle's official devnet USDC mint (6 decimals). Override with SOLANA_USDC. */
export const SOLANA_USDC = process.env.SOLANA_USDC ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const SOLANA_USDC_DECIMALS = 6;

/** CAIP-2 network id for Solana devnet (genesis hash prefix), as x402 expects. */
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_EXPLORER = "https://explorer.solana.com";

export function solConnection(): Connection {
  return new Connection(SOLANA_RPC, "confirmed");
}

/** Explorer link for an address or tx on devnet. */
export function solExplorer(kind: "address" | "tx", id: string): string {
  return `${SOLANA_EXPLORER}/${kind}/${id}?cluster=devnet`;
}

/** Fresh Solana keypair. The agent keeps the secret; only the pubkey is public. */
export function createSolanaWallet(): { address: string; secretKeyBase58: string } {
  const kp = Keypair.generate();
  return { address: kp.publicKey.toBase58(), secretKeyBase58: bs58.encode(kp.secretKey) };
}

/** Load a keypair from a base58 secret (what createSolanaWallet emits). */
export function solanaKeypairFromBase58(secret: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secret));
}

export function isSolanaAddress(addr: string): boolean {
  try { new PublicKey(addr); return addr.length >= 32 && addr.length <= 44; } catch { return false; }
}

/** Native SOL balance (for tx fees) in SOL. */
export async function solBalance(address: string): Promise<number> {
  const lamports = await solConnection().getBalance(new PublicKey(address));
  return lamports / LAMPORTS_PER_SOL;
}

/** USDC (SPL) balance for an address, in whole USDC. Zero if no token account. */
export async function usdcBalance(address: string): Promise<number> {
  const conn = solConnection();
  const owner = new PublicKey(address);
  const mint = new PublicKey(SOLANA_USDC);
  try {
    const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID);
    const acc = await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID);
    return Number(acc.amount) / 10 ** SOLANA_USDC_DECIMALS;
  } catch {
    return 0; // no ATA yet == 0 balance
  }
}

/** Both balances plus a funding verdict, mirroring the EVM `balancesFor`. */
export async function solanaBalances(address: string): Promise<{
  address: string; sol: number; usdc: number; needsGas: boolean; funded: boolean;
}> {
  const [sol, usdc] = await Promise.all([solBalance(address), usdcBalance(address)]);
  return { address, sol, usdc, needsGas: sol <= 0, funded: usdc > 0 };
}

/** Request a devnet SOL airdrop (for tx fees). Devnet only; may be rate-limited. */
export async function airdropSol(address: string, sol = 1): Promise<string> {
  const conn = solConnection();
  const sig = await conn.requestAirdrop(new PublicKey(address), sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}
