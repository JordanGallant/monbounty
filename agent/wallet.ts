/**
 * The agent's wallet. This is the module a person funds: they drop USDC (and a
 * little MON, though the facilitator sponsors settlement gas) into `address`
 * on whichever Monad network, and the agent spends it on bonds by itself.
 *
 * Read-only over RPC — the private key never leaves here except to sign x402
 * payments via makePayingClient. There is no withdraw path on purpose: the
 * agent can spend on bonds but cannot move funds out to an arbitrary address.
 */
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENABLED, NETWORKS, type MonadNet, type NetKey } from "../lib/config";

export interface NetworkBalance {
  network: NetKey;
  networkId: string;
  name: string;
  usdc: number;      // human units
  usdcAtomic: string;
  mon: number;       // native, human units
  explorer: string;
}

export interface WalletStatus {
  address: string;
  balances: NetworkBalance[];
  totalUsdc: number;
}

const clients = new Map<NetKey, ReturnType<typeof createPublicClient>>();
function rpc(net: MonadNet) {
  let c = clients.get(net.key);
  if (!c) {
    c = createPublicClient({ transport: http(net.rpc) });
    clients.set(net.key, c);
  }
  return c;
}

export class AgentWallet {
  readonly address: `0x${string}`;
  constructor(private privateKey: string) {
    this.address = privateKeyToAccount(privateKey as `0x${string}`).address;
  }

  async balanceOn(net: MonadNet): Promise<NetworkBalance> {
    const c = rpc(net);
    const [usdcAtomic, mon] = await Promise.all([
      c.readContract({ address: net.usdc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [this.address] }).catch(() => 0n),
      c.getBalance({ address: this.address }).catch(() => 0n),
    ]);
    return {
      network: net.key,
      networkId: net.id,
      name: net.name,
      usdc: Number(formatUnits(usdcAtomic as bigint, net.usdcDecimals)),
      usdcAtomic: (usdcAtomic as bigint).toString(),
      mon: Number(formatUnits(mon as bigint, 18)),
      explorer: net.explorer,
    };
  }

  async status(): Promise<WalletStatus> {
    const balances = await Promise.all(ENABLED.map((n) => this.balanceOn(n)));
    return {
      address: this.address,
      balances,
      totalUsdc: Number(balances.reduce((s, b) => s + b.usdc, 0).toFixed(6)),
    };
  }

  /** Can the agent cover `usd` on the given network right now? */
  async canAfford(usd: number, network?: NetKey): Promise<{ ok: boolean; have: number; need: number; network: NetKey }> {
    const net = network ? NETWORKS[network] : ENABLED[0];
    const b = await this.balanceOn(net);
    return { ok: b.usdc >= usd, have: b.usdc, need: usd, network: net.key };
  }
}

export function walletFromEnv(): AgentWallet {
  const pk = process.env.HUNTER_PRIVATE_KEY;
  if (!pk) throw new Error("HUNTER_PRIVATE_KEY not set — the agent has no wallet to spend from.");
  return new AgentWallet(pk);
}
