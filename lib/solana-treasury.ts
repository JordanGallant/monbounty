// Solana treasury — pays USDC (SPL) on devnet. The payout side of the Solana
// rail: refunds bonds and pays awards, mirroring lib/treasury (EVM). The
// treasury keypair signs and pays the tx fee, and creates the recipient's token
// account idempotently if it doesn't exist yet (so a first-time hunter still
// gets paid). Same keypair funds the fee for x402 bond receipt (its own ATA).
//
// Needs: the treasury holds SOL (gas) + USDC (to pay awards). On devnet, fund it
// from a faucet or transfer; SOLANA_FEEPAYER_SECRET is the treasury key.

import {
  Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getAccount,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { solConnection, SOLANA_USDC, SOLANA_USDC_DECIMALS, solExplorer } from "./solana";
import bs58 from "bs58";

export function solanaTreasuryFromEnv(): SolanaTreasury {
  const secret = process.env.SOLANA_TREASURY_SECRET ?? process.env.SOLANA_FEEPAYER_SECRET;
  if (!secret) throw new Error("SOLANA_TREASURY_SECRET (or SOLANA_FEEPAYER_SECRET) not set");
  return new SolanaTreasury(Keypair.fromSecretKey(bs58.decode(secret)));
}

export class SolanaTreasury {
  readonly conn: Connection;
  readonly mint: PublicKey;
  constructor(readonly keypair: Keypair) {
    this.conn = solConnection();
    this.mint = new PublicKey(SOLANA_USDC);
  }
  get address(): string { return this.keypair.publicKey.toBase58(); }

  async balances(): Promise<{ sol: number; usdc: number }> {
    const [lam, usdc] = await Promise.all([
      this.conn.getBalance(this.keypair.publicKey),
      this.usdc(this.keypair.publicKey),
    ]);
    return { sol: lam / LAMPORTS_PER_SOL, usdc };
  }

  private async usdc(owner: PublicKey): Promise<number> {
    try {
      const ata = await getAssociatedTokenAddress(this.mint, owner, false, TOKEN_PROGRAM_ID);
      const acc = await getAccount(this.conn, ata, "confirmed", TOKEN_PROGRAM_ID);
      return Number(acc.amount) / 10 ** SOLANA_USDC_DECIMALS;
    } catch { return 0; }
  }

  /**
   * Ensure `owner` has a USDC associated token account, creating it idempotently
   * (treasury pays the rent). Returns the ATA address. Use to prepare a payTo
   * that has never held USDC so x402 transfers to it can succeed.
   */
  async ensureAta(owner: string): Promise<string> {
    const ownerPk = new PublicKey(owner);
    const ata = await getAssociatedTokenAddress(this.mint, ownerPk, false, TOKEN_PROGRAM_ID);
    try { await getAccount(this.conn, ata, "confirmed", TOKEN_PROGRAM_ID); return ata.toBase58(); } catch {}
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.keypair.publicKey, ata, ownerPk, this.mint, TOKEN_PROGRAM_ID),
    );
    const sig = await this.conn.sendTransaction(tx, [this.keypair]);
    await this.conn.confirmTransaction(sig, "confirmed");
    return ata.toBase58();
  }

  /**
   * Pay `usdc` USDC to `to`. Creates the recipient's token account if needed
   * (idempotent), then TransferChecked from the treasury's ATA. Treasury signs
   * and pays the fee. Returns the tx signature + explorer link.
   */
  async pay(to: string, usdc: number): Promise<{ signature: string; url: string }> {
    const toPk = new PublicKey(to);
    const fromAta = await getAssociatedTokenAddress(this.mint, this.keypair.publicKey, false, TOKEN_PROGRAM_ID);
    const toAta = await getAssociatedTokenAddress(this.mint, toPk, false, TOKEN_PROGRAM_ID);
    const amount = BigInt(Math.round(usdc * 10 ** SOLANA_USDC_DECIMALS));
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.keypair.publicKey, toAta, toPk, this.mint, TOKEN_PROGRAM_ID),
      createTransferCheckedInstruction(
        fromAta, this.mint, toAta, this.keypair.publicKey, amount, SOLANA_USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
    );
    const sig = await this.conn.sendTransaction(tx, [this.keypair]);
    await this.conn.confirmTransaction(sig, "confirmed");
    return { signature: sig, url: solExplorer("tx", sig) };
  }
}
