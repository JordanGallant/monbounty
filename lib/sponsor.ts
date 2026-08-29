// Gas sponsorship: the platform/company wallet (which holds MON) drips a tiny
// amount of gas to a hunter so it can register its ERC-8004 identity. This is
// what lets the agent experience need ONLY USDC — every MON cost is sponsored
// (registration gas here, bond settlement gas by the x402 facilitator).
import { createWalletClient, createPublicClient, http, defineChain, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, type NetKey } from "./config";

const DRIP_MON = process.env.SPONSOR_GAS_MON ?? "0.02";       // per registration
const MIN_BAL_WEI = parseEther("0.005");                       // only drip if under this

function chainFor(net: NetKey) {
  const n = NETWORKS[net];
  return defineChain({ id: n.chainId, name: n.name, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [n.rpc] } } });
}

export interface SponsorResult {
  sponsored: boolean; reason: string; txHash?: string; alreadyFunded?: boolean; balanceWei?: string;
}

/** Send registration gas to `address` if it's (near) empty. Idempotent-ish: a
 *  wallet that already has gas is left alone. */
export async function sponsorGas(address: string, net: NetKey = "testnet"): Promise<SponsorResult> {
  const key = process.env.TREASURY_PRIVATE_KEY;
  if (!key) return { sponsored: false, reason: "no sponsor wallet configured (TREASURY_PRIVATE_KEY)" };
  const chain = chainFor(net);
  const pub = createPublicClient({ chain, transport: http(NETWORKS[net].rpc) });

  const bal = await pub.getBalance({ address: address as `0x${string}` });
  if (bal >= MIN_BAL_WEI) return { sponsored: false, alreadyFunded: true, reason: "wallet already has gas", balanceWei: bal.toString() };

  // Don't drip out more than the sponsor can cover.
  const account = privateKeyToAccount(key as `0x${string}`);
  const sponsorBal = await pub.getBalance({ address: account.address });
  const amount = parseEther(DRIP_MON);
  if (sponsorBal < amount) return { sponsored: false, reason: `sponsor wallet ${account.address} is out of MON` };

  const wallet = createWalletClient({ account, chain, transport: http(NETWORKS[net].rpc) });
  const txHash = await wallet.sendTransaction({ to: address as `0x${string}`, value: amount });
  await pub.waitForTransactionReceipt({ hash: txHash });
  return { sponsored: true, reason: `dripped ${DRIP_MON} MON for registration gas`, txHash };
}
