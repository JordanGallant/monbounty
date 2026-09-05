/**
 * viem wrapper over the deployed SubmissionRegistry — the escrow that makes a
 * bond refund enforceable instead of promised. Two roles use it:
 *
 *   - the platform/treasury (registry owner): record() / recordRevealed() to
 *     bind a settled x402 bond to a report;
 *   - a company's ruler: grade(); then anyone may settle() to move the money.
 *
 * Bounty ids and rules are hashed the same way the Solidity does:
 * keccak256 of the UTF-8 bytes, so `programId("monad-escrow-demo")` here equals
 * `keccak256("monad-escrow-demo")` on chain.
 */
import {
  createPublicClient, createWalletClient, http, erc20Abi,
  keccak256, toBytes, parseAbi, encodeAbiParameters, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, registryFor, type MonadNet, type NetKey } from "./config";

export const REGISTRY_ABI = parseAbi([
  "function createBounty(bytes32 bounty, address ruler, bytes32 rulesHash, uint256[5] tiers, uint64 slaSeconds)",
  "function fundBounty(bytes32 bounty, uint256 amount)",
  "function record(bytes32 id, address payer, bytes32 program, uint256 amount, bytes32 contentHash)",
  "function recordRevealed(bytes32 id, address payer, bytes32 program, uint256 amount, bytes32 contentHash, bytes32 salt)",
  "function topUp(bytes32 id, uint256 amount)",
  "function commit(bytes32 commitHash)",
  "function commitHashFor(address by, bytes32 program, bytes32 contentHash, bytes32 salt) view returns (bytes32)",
  "function grade(bytes32 id, uint8 v, uint8 tier)",
  "function settle(bytes32 id)",
  "function claimTimeout(bytes32 id)",
  "function canAcceptSubmission(bytes32 bounty) view returns (bool)",
  "function poolRemaining(bytes32 bounty) view returns (uint256 free, uint256 reserved)",
  "function priorityAt(bytes32 id) view returns (uint64)",
  "function firstCommitFor(bytes32 contentHash) view returns (bytes32)",
  "function maxAward(bytes32 bounty) view returns (uint256)",
  "function tiersOf(bytes32 bounty) view returns (uint256[5])",
  "function unassigned() view returns (uint256)",
  "function bounties(bytes32) view returns (address ruler, bytes32 rulesHash, uint256 pool, uint256 reserved, uint64 slaSeconds, bool active)",
]);

/** Verdict enum in SubmissionRegistry. */
export const VERDICT = { Pending: 0, Valid: 1, Duplicate: 2, OutOfScope: 3, Slop: 4 } as const;
/** Severity -> tier index (0 critical .. 4 informational). */
export const TIER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };

/** keccak256 of the UTF-8 bytes — matches Solidity keccak256(string). */
export const hashUtf8 = (s: string): Hex => keccak256(toBytes(s));
export const programId = hashUtf8;
/** A deterministic salt for a report's commit (kept off chain until reveal). */
export const saltFor = (reportId: string, secret: string): Hex => keccak256(toBytes(`${reportId}:${secret}`));

export class Registry {
  readonly address: Hex;
  private account;
  private net: MonadNet;
  constructor(privateKey: string, network: NetKey) {
    this.net = NETWORKS[network];
    const addr = registryFor(this.net);
    if (!addr) throw new Error(`No SubmissionRegistry configured for ${network}`);
    this.address = addr as Hex;
    this.account = privateKeyToAccount(privateKey as Hex);
  }
  private pub() { return createPublicClient({ transport: http(this.net.rpc) }); }
  private wal() { return createWalletClient({ account: this.account, transport: http(this.net.rpc) }); }
  private async send(functionName: string, args: any[]) {
    const hash = await this.wal().writeContract({ address: this.address, abi: REGISTRY_ABI, functionName: functionName as any, args, chain: null });
    const rcpt = await this.pub().waitForTransactionReceipt({ hash });
    return { hash, status: rcpt.status, explorerUrl: `${this.net.explorer}/tx/${hash}` };
  }
  private async read(functionName: string, args: any[] = []) {
    return this.pub().readContract({ address: this.address, abi: REGISTRY_ABI, functionName: functionName as any, args });
  }

  // company side
  approveUsdc(amountAtomic: bigint) {
    return this.wal().writeContract({ address: this.net.usdc as Hex, abi: erc20Abi, functionName: "approve", args: [this.address, amountAtomic], chain: null })
      .then((hash) => this.pub().waitForTransactionReceipt({ hash }).then((r) => ({ hash, status: r.status })));
  }
  createBounty(program: string, ruler: Hex, rulesHash: Hex, tiersAtomic: bigint[], slaSeconds: number) {
    return this.send("createBounty", [programId(program), ruler, rulesHash, tiersAtomic, BigInt(slaSeconds)]);
  }
  fundBounty(program: string, amountAtomic: bigint) { return this.send("fundBounty", [programId(program), amountAtomic]); }

  // hunter/platform side
  commit(commitHash: Hex) { return this.send("commit", [commitHash]); }
  commitHashFor(by: Hex, program: string, contentHash: Hex, salt: Hex) {
    return this.read("commitHashFor", [by, programId(program), contentHash, salt]) as Promise<Hex>;
  }
  record(id: string, payer: Hex, program: string, amountAtomic: bigint, contentHash: Hex) {
    return this.send("record", [hashUtf8(id), payer, programId(program), amountAtomic, contentHash]);
  }
  recordRevealed(id: string, payer: Hex, program: string, amountAtomic: bigint, contentHash: Hex, salt: Hex) {
    return this.send("recordRevealed", [hashUtf8(id), payer, programId(program), amountAtomic, contentHash, salt]);
  }
  // verdict + money
  grade(id: string, verdict: number, tier: number) { return this.send("grade", [hashUtf8(id), verdict, tier]); }
  settle(id: string) { return this.send("settle", [hashUtf8(id)]); }

  // reads
  canAccept(program: string) { return this.read("canAcceptSubmission", [programId(program)]) as Promise<boolean>; }
  poolRemaining(program: string) { return this.read("poolRemaining", [programId(program)]) as Promise<[bigint, bigint]>; }
  priorityAt(id: string) { return this.read("priorityAt", [hashUtf8(id)]) as Promise<bigint>; }
  bounty(program: string) { return this.read("bounties", [programId(program)]) as Promise<any>; }
}
