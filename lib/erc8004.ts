// ERC-8004 (Trustless Agents) integration on Monad.
//
// Two singleton registries, deployed by the 8004 team on Monad:
//   Identity   — ERC-721; an agent mints an identity whose tokenURI is its
//                agent card. register(agentURI) -> agentId.
//   Reputation — feedback signals about an agentId. getSummary(...) -> a score.
//
// We use them two ways: a hunter agent registers an identity (portable, and the
// same address that pays our x402 owns it), and the company side reads that
// identity's on-chain reputation as one input to its accept/deny decision.
import { createPublicClient, http, encodeFunctionData, decodeEventLog, type Hex } from "viem";
import { NETWORKS, type NetKey } from "./config";

export const ERC8004 = {
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Hex,
  reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Hex,
};

export const IDENTITY_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "event", name: "Transfer", inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true } ] },
] as const;

export const REPUTATION_ABI = [
  { type: "function", name: "getSummary", stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ] },
] as const;

function client(net: NetKey) {
  const n = NETWORKS[net];
  return createPublicClient({ transport: http(n.rpc) });
}

/** Calldata for register(agentURI) — the agent signs and sends this itself. */
export function registerCalldata(agentURI: string): Hex {
  return encodeFunctionData({ abi: IDENTITY_ABI, functionName: "register", args: [agentURI] });
}

/** Pull the minted agentId out of the register tx's Transfer(from=0) log. */
export function agentIdFromReceipt(logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[]): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== ERC8004.identity.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: IDENTITY_ABI, topics: log.topics as any, data: log.data });
      if (ev.eventName === "Transfer") return (ev.args as any).tokenId as bigint;
    } catch {}
  }
  return null;
}

export interface OnchainReputation {
  agentId: string;
  count: number;
  value: number;       // summaryValue scaled by decimals
  raw: string;
}

/** Company-side read: the on-chain reputation summary for an agentId. */
export async function readReputation(agentId: bigint, net: NetKey = "testnet"): Promise<OnchainReputation | null> {
  try {
    const [count, summaryValue, decimals] = await client(net).readContract({
      address: ERC8004.reputation, abi: REPUTATION_ABI, functionName: "getSummary",
      args: [agentId, [], "", ""],
    }) as [bigint, bigint, number];
    const scale = decimals > 0 ? Number(summaryValue) / 10 ** decimals : Number(summaryValue);
    return { agentId: agentId.toString(), count: Number(count), value: scale, raw: summaryValue.toString() };
  } catch {
    return null; // registry not reachable or no feedback yet — caller falls back
  }
}

/** Confirm an agentId is really owned by the wallet that claims it. */
export async function ownerOfAgent(agentId: bigint, net: NetKey = "testnet"): Promise<string | null> {
  try {
    return (await client(net).readContract({
      address: ERC8004.identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [agentId],
    })) as string;
  } catch { return null; }
}
