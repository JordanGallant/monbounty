/**
 * Read-only USDC/MON balances for any address on the enabled Monad networks.
 *
 * Split out of agent/wallet.ts so the server can answer "is this wallet funded
 * yet?" without constructing an AgentWallet — which needs a private key it has
 * no business holding for a Circle-provisioned wallet.
 */
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { ENABLED, type MonadNet, type NetKey } from "./config";

export interface Balance {
  network: NetKey;
  networkId: string;
  name: string;
  usdc: number;
  usdcAtomic: string;
  mon: number;
  explorer: string;
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

export async function balanceOn(address: string, net: MonadNet): Promise<Balance> {
  const c = rpc(net);
  const [usdcAtomic, mon] = await Promise.all([
    c
      .readContract({
        address: net.usdc as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      })
      .catch(() => 0n),
    c.getBalance({ address: address as `0x${string}` }).catch(() => 0n),
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

export async function balancesFor(address: string): Promise<Balance[]> {
  return Promise.all(ENABLED.map((n) => balanceOn(address, n)));
}
