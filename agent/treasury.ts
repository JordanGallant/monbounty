/**
 * Agent 2's wallet — the treasury. Unlike the hunter wallet (which can only
 * bond, never withdraw), the treasury PUSHES USDC out: bond refunds and bounty
 * awards, paid straight to a hunter's address.
 *
 * A payout is a push, so it can't be x402 (a pull protocol). It's a direct
 * ERC-20 transfer the treasury signs itself — which is why this wallet needs
 * MON for gas, and the hunter wallet does not.
 */
import { createPublicClient, createWalletClient, http, erc20Abi, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, type MonadNet, type NetKey } from "../lib/config";

export interface Payout {
  ok: boolean;
  txHash?: string;
  explorerUrl?: string;
  amountUsd: number;
  to: string;
  network: NetKey;
  error?: string;
}

export class Treasury {
  readonly address: `0x${string}`;
  private account;
  constructor(privateKey: string) {
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
    this.address = this.account.address;
  }

  private pub(net: MonadNet) {
    return createPublicClient({ transport: http(net.rpc) });
  }
  private wallet(net: MonadNet) {
    return createWalletClient({ account: this.account, transport: http(net.rpc) });
  }

  async balance(network: NetKey) {
    const net = NETWORKS[network];
    const [usdc, mon] = await Promise.all([
      this.pub(net).readContract({ address: net.usdc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [this.address] }).catch(() => 0n),
      this.pub(net).getBalance({ address: this.address }).catch(() => 0n),
    ]);
    return {
      network,
      usdc: Number(formatUnits(usdc as bigint, net.usdcDecimals)),
      usdcAtomic: (usdc as bigint).toString(),
      mon: Number(formatUnits(mon as bigint, 18)),
    };
  }

  /**
   * Send `amountUsd` USDC to `to`. Waits for the receipt so the caller gets a
   * real tx hash to record. Refuses if the treasury can't cover it — an award
   * the agent can't actually pay must fail loudly, not silently under-pay.
   */
  async pay(to: string, amountUsd: number, network: NetKey): Promise<Payout> {
    const net = NETWORKS[network];
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { ok: false, error: "bad_recipient", amountUsd, to, network };
    if (!(amountUsd > 0)) return { ok: false, error: "bad_amount", amountUsd, to, network };

    const bal = await this.balance(network);
    if (bal.usdc < amountUsd)
      return { ok: false, error: `treasury_underfunded (has ${bal.usdc} USDC, needs ${amountUsd})`, amountUsd, to, network };
    if (bal.mon <= 0)
      return { ok: false, error: "treasury_no_gas (needs MON to send a payout tx)", amountUsd, to, network };

    const value = parseUnits(String(amountUsd), net.usdcDecimals);
    try {
      const hash = await this.wallet(net).writeContract({
        address: net.usdc as `0x${string}`,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to as `0x${string}`, value],
        chain: null,
      });
      await this.pub(net).waitForTransactionReceipt({ hash });
      return { ok: true, txHash: hash, explorerUrl: `${net.explorer}/tx/${hash}`, amountUsd, to, network };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), amountUsd, to, network };
    }
  }
}

export function treasuryFromEnv(): Treasury {
  const pk = process.env.TREASURY_PRIVATE_KEY;
  if (!pk) throw new Error("TREASURY_PRIVATE_KEY not set — Agent 2 has no wallet to pay from.");
  return new Treasury(pk);
}
