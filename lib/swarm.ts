// Swarm storage adapter — the censorship-resistant evidence layer.
//
// monbounty's trust spine is hash-commitment: every program's rules, every
// report, and every verdict is reduced to a keccak256 hash that is committed
// on-chain. On its own a hash only proves "the thing I'm holding matches what
// was committed" — it does NOT make the thing itself durable or retrievable.
// A company could still delete a valid report from its database.
//
// Swarm closes that gap. We upload the *actual* canonical bytes to Swarm, a
// global P2P storage network, and keep the returned content reference. Because
// Swarm is content-addressed, the reference is derived from the bytes, and the
// keccak256 of those same bytes is exactly the value already committed on-chain
// (see lib/rules.ts). So one artifact ties three anchors together:
//
//     on-chain rulesHash  ==  keccak256(canonical bytes)  ==  what Swarm serves
//
// and, via lib/ens.ts, an ENS name's contenthash points at that Swarm reference
// so a human-readable `name.eth` resolves to the immutable rules.
//
// No bee node required: the public Swarm gateway accepts uploads and serves
// reads. For production you would run your own Bee node and buy a real postage
// stamp batch (paid in BZZ on Gnosis Chain); the interface here is identical —
// set SWARM_GATEWAY to your node and SWARM_POSTAGE_BATCH to your batch id.

import { keccak256, toBytes } from "viem";

export const SWARM_ENABLED = (process.env.SWARM_ENABLED ?? "1") !== "0";

/** Public Swarm gateway (accepts stampless uploads) or your own Bee node. */
export const SWARM_GATEWAY =
  (process.env.SWARM_GATEWAY ?? "https://api.gateway.ethswarm.org").replace(/\/+$/, "");

/**
 * Postage batch id. The public gateway accepts the all-zero batch; a real Bee
 * node needs a batch you bought with `bee.buyStorage(...)` / the stamp contract.
 */
export const SWARM_POSTAGE_BATCH =
  process.env.SWARM_POSTAGE_BATCH ?? "0000000000000000000000000000000000000000000000000000000000000000";

/** A browser-openable link to a Swarm reference (eth.limo-style gateway URL). */
export function bzzUrl(reference: string, gateway = SWARM_GATEWAY): string {
  return `${gateway}/bzz/${reference}/`;
}

/** The bzz:// URI form used in ENS contenthash and dweb tooling. */
export function bzzUri(reference: string): string {
  return `bzz://${reference}`;
}

export interface SwarmUpload {
  reference: string;
  /** keccak256 of the exact bytes uploaded — matches the on-chain commitment. */
  contentHash: `0x${string}`;
  url: string;
  encrypted: boolean;
  bytes: number;
}

/**
 * Upload bytes (or a string) to Swarm and return the content reference plus the
 * keccak256 of those bytes. `encrypt` uses Swarm's native encryption — the
 * returned reference then embeds the decryption key, so only a holder of the
 * reference can read it (used for reports kept private until disclosure).
 */
export async function swarmUpload(
  data: string | Uint8Array,
  opts: { encrypt?: boolean; contentType?: string; filename?: string; timeoutMs?: number } = {},
): Promise<SwarmUpload> {
  const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const contentHash = keccak256(typeof data === "string" ? toBytes(data) : data);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const url = new URL(`${SWARM_GATEWAY}/bzz`);
    if (opts.filename) url.searchParams.set("name", opts.filename);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": opts.contentType ?? "application/octet-stream",
        "Swarm-Postage-Batch-Id": SWARM_POSTAGE_BATCH,
        "Swarm-Deferred-Upload": "true",
        ...(opts.encrypt ? { "Swarm-Encrypt": "true" } : {}),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`swarm upload ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { reference?: string };
    if (!json.reference) throw new Error("swarm upload: no reference in response");
    return {
      reference: json.reference,
      contentHash,
      url: bzzUrl(json.reference),
      encrypted: Boolean(opts.encrypt),
      bytes: body.byteLength,
    };
  } finally {
    clearTimeout(to);
  }
}

/** Retrieve the bytes stored at a Swarm reference, as a string. */
export async function swarmRetrieveText(reference: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(bzzUrl(reference), { signal: controller.signal });
    if (!res.ok) throw new Error(`swarm read ${res.status} for ${reference}`);
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

/**
 * Round-trip integrity check: fetch a reference back from Swarm and confirm its
 * keccak256 equals the hash committed on-chain. This is the proof a hunter (or a
 * judge) runs to verify the rules were never altered after publication.
 */
export async function swarmVerify(
  reference: string,
  expectedHash: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; retrievedHash: `0x${string}`; bytes: number }> {
  const text = await swarmRetrieveText(reference, timeoutMs);
  const retrievedHash = keccak256(toBytes(text));
  return {
    ok: retrievedHash.toLowerCase() === expectedHash.toLowerCase(),
    retrievedHash,
    bytes: new TextEncoder().encode(text).byteLength,
  };
}
