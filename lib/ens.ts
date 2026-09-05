// ENS — human-readable names for the censorship-resistant artifacts on Swarm.
//
// ENS's contenthash record (ENSIP-7 / EIP-1577) natively supports Swarm: a name
// can point at a Swarm reference using multicodec namespace 0xe4 ("swarm"). So a
// bounty program stored on Swarm (lib/swarm.ts) can be resolved by a name like
//
//     monadstake-vault.monbounty.eth  ->  contenthash  ->  bzz://<ref>  ->  rules
//
// and any ENS-aware browser / eth.limo resolves it. This is what makes the three
// anchors legible to a human: on-chain rulesHash, Swarm content, and an ENS name
// all agree, and the name is the part a person can actually read and trust.
//
// This module encodes a Swarm reference into an ENS contenthash, produces the
// exact `setContenthash` calldata a name owner signs, and reads a name's
// contenthash back from mainnet to prove resolution.

import {
  namehash,
  encodeFunctionData,
  createPublicClient,
  http,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

/** ENS registry (same address on mainnet and most testnets). */
export const ENS_REGISTRY: Address = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

/** Public RPC used to read contenthash records. Override with ENS_RPC. */
export const ENS_RPC = process.env.ENS_RPC ?? "https://ethereum-rpc.publicnode.com";

/**
 * The parent name monbounty issues program subnames under, e.g.
 * `<slug>.monbounty.eth`. Set MONBOUNTY_ENS once you register/control a name.
 */
export const MONBOUNTY_ENS_PARENT = process.env.MONBOUNTY_ENS_PARENT ?? "monbounty.eth";

// Swarm contenthash prefix per ENSIP-7 / the content-hash spec:
//   e4 01      varint multicodec 0xe4 = "swarm"
//   01         CID version 1
//   fa 01      varint multicodec 0xfa = "swarm-manifest"
//   1b         multihash: keccak-256
//   20         digest length = 32 bytes
// followed by the 32-byte Swarm reference.
const SWARM_CONTENTHASH_PREFIX = "e40101fa011b20";

/** True for a 32-byte (unencrypted) Swarm reference, which ENS can encode. */
export function isPlainSwarmRef(reference: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(reference);
}

/**
 * Encode a 32-byte Swarm reference as an ENS contenthash value. Encrypted
 * references (64 bytes) are not representable in the standard swarm contenthash
 * and are rejected — use an unencrypted reference for anything ENS points at.
 */
export function encodeSwarmContenthash(reference: string): `0x${string}` {
  const ref = reference.replace(/^0x/, "").toLowerCase();
  if (!isPlainSwarmRef(ref)) {
    throw new Error(`ENS swarm contenthash needs a 32-byte reference, got ${ref.length / 2} bytes`);
  }
  return `0x${SWARM_CONTENTHASH_PREFIX}${ref}`;
}

/** Decode an ENS contenthash back to a Swarm reference (or null if not swarm). */
export function decodeSwarmContenthash(contenthash: string): string | null {
  const h = contenthash.replace(/^0x/, "").toLowerCase();
  if (!h.startsWith(SWARM_CONTENTHASH_PREFIX)) return null;
  const ref = h.slice(SWARM_CONTENTHASH_PREFIX.length);
  return isPlainSwarmRef(ref) ? ref : null;
}

const RESOLVER_SET_CONTENTHASH = [{
  name: "setContenthash",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [{ name: "node", type: "bytes32" }, { name: "hash", type: "bytes" }],
  outputs: [],
}] as const;

const RESOLVER_CONTENTHASH = [{
  name: "contenthash",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "node", type: "bytes32" }],
  outputs: [{ name: "", type: "bytes" }],
}] as const;

const REGISTRY_RESOLVER = [{
  name: "resolver",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "node", type: "bytes32" }],
  outputs: [{ name: "", type: "address" }],
}] as const;

/**
 * Everything a name owner needs to point `name` at a Swarm reference: the ENS
 * node, the encoded contenthash, and the calldata to send to that name's
 * resolver. monbounty produces this; the human owner signs it from their wallet
 * (the platform never holds the name's key).
 */
export function setContenthashPlan(name: string, reference: string) {
  const node = namehash(name);
  const contenthash = encodeSwarmContenthash(reference);
  const calldata = encodeFunctionData({
    abi: RESOLVER_SET_CONTENTHASH,
    functionName: "setContenthash",
    args: [node, contenthash],
  });
  return { name, node, contenthash, calldata, bzz: `bzz://${reference.replace(/^0x/, "")}` };
}

/**
 * Read a name's contenthash from mainnet and, if it's a Swarm reference, return
 * it decoded. Proves the on-chain ENS record actually resolves to our content.
 */
export async function readEnsSwarm(
  name: string,
  rpcUrl = ENS_RPC,
): Promise<{ name: string; node: `0x${string}`; resolver: Address | null; contenthash: string | null; swarmRef: string | null }> {
  const node = namehash(name);
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  const resolver = (await client.readContract({
    address: ENS_REGISTRY, abi: REGISTRY_RESOLVER, functionName: "resolver", args: [node],
  })) as Address;
  if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
    return { name, node, resolver: null, contenthash: null, swarmRef: null };
  }
  const contenthash = (await client.readContract({
    address: resolver, abi: RESOLVER_CONTENTHASH, functionName: "contenthash", args: [node],
  })) as string;
  return {
    name, node, resolver,
    contenthash: contenthash && contenthash !== "0x" ? contenthash : null,
    swarmRef: contenthash ? decodeSwarmContenthash(contenthash) : null,
  };
}

/** The subname monbounty would issue for a program slug. */
export function programEnsName(slug: string): string {
  return `${slug}.${MONBOUNTY_ENS_PARENT}`;
}
