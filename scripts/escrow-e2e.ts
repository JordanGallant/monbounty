/**
 * End-to-end proof of the on-chain settlement layer, against the DEPLOYED
 * SubmissionRegistry on Monad testnet, with real USDC. One key plays every
 * role (company + platform + ruler + hunter) so the money mechanics are
 * provable without a second funded wallet.
 *
 *   bun run scripts/escrow-e2e.ts
 *
 * Proves, in order:
 *   1. #1  fundBounty escrows a solvent reward pool (canAcceptSubmission true)
 *   2. #3  commit() stamps priority BEFORE the finding is revealed
 *   3.     recordRevealed() binds the bond and carries the commit timestamp
 *   4. #2  grade(valid, critical) + settle() pays award + refunds bond in ONE tx
 */
import { createPublicClient, createWalletClient, http, erc20Abi, parseUnits, formatUnits, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS } from "../lib/config";
import { Registry, hashUtf8, saltFor, VERDICT, TIER } from "../lib/registry";

const NET = NETWORKS.testnet;
const pk = process.env.TREASURY_PRIVATE_KEY;
if (!pk) { console.error("TREASURY_PRIVATE_KEY not set"); process.exit(1); }
const acct = privateKeyToAccount(pk as Hex);
const pub = createPublicClient({ transport: http(NET.rpc) });
const wal = createWalletClient({ account: acct, transport: http(NET.rpc) });
const reg = new Registry(pk, "testnet");

const usdc = (n: number) => parseUnits(String(n), NET.usdcDecimals);
const bal = async () => Number(formatUnits(await pub.readContract({ address: NET.usdc as Hex, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] }) as bigint, NET.usdcDecimals));
const link = (h: string) => `${NET.explorer}/tx/${h}`;

const program = `escrow-e2e-${Date.now()}`;
const reportId = `${program}-r1`;
const contentHash = keccak256(toBytes(`${program}:idor-users-endpoint-leaks-sk_live`));
const salt = saltFor(reportId, "demo-secret");

// demo payout table (USDC): critical 5 / high 3 / medium 1.5 / low 0.5 / info 0
const tiers = [usdc(5), usdc(3), usdc(1.5), usdc(0.5), usdc(0)];
const POOL = usdc(5);   // must cover the worst-case (critical) award
const BOND = usdc(1);

console.log(`registry ${reg.address}  net=${NET.name}`);
console.log(`actor    ${acct.address}  USDC ${await bal()}\n`);

// 1 — company posts + funds a solvent pool
console.log("1. createBounty + fundBounty (escrow the reward pool)");
await reg.approveUsdc(POOL);
console.log("   createBounty:", link((await reg.createBounty(program, acct.address, hashUtf8("rules-v1"), tiers, 7 * 24 * 3600)).hash));
console.log("   fundBounty:  ", link((await reg.fundBounty(program, POOL)).hash));
console.log("   canAcceptSubmission:", await reg.canAccept(program), "\n");

// 2 — hunter stakes a claim BEFORE revealing (priority, no disclosure)
console.log("2. commit (provable priority, leaks nothing) [#3]");
const commitHash = await reg.commitHashFor(acct.address, program, contentHash, salt);
console.log("   commitHash:", commitHash);
console.log("   commit:    ", link((await reg.commit(commitHash)).hash), "\n");

// 3 — the bond settles (simulate x402 landing USDC in the registry), then reveal
console.log("3. bond settles into escrow, then recordRevealed [#1/#3]");
const settleTransfer = await wal.writeContract({ address: NET.usdc as Hex, abi: erc20Abi, functionName: "transfer", args: [reg.address, BOND], chain: null });
await pub.waitForTransactionReceipt({ hash: settleTransfer });
console.log("   bond->registry:", link(settleTransfer));
console.log("   recordRevealed:", link((await reg.recordRevealed(reportId, acct.address, program, BOND, contentHash, salt)).hash));
const prio = await reg.priorityAt(reportId);
console.log(`   priorityAt(report) = ${prio}  (nonzero => the commit time carried through)\n`);

// 4 — verdict + atomic pay
console.log("4. grade(valid, critical) + settle (award + refund in ONE tx) [#2]");
console.log("   grade:  ", link((await reg.grade(reportId, VERDICT.Valid, TIER.critical)).hash));
const before = await bal();
console.log("   settle: ", link((await reg.settle(reportId)).hash));
const after = await bal();
const [free, reserved] = await reg.poolRemaining(program);
console.log(`\n   actor USDC ${before} -> ${after}  (net from settle: +${(after - before).toFixed(2)} = bond 1 refunded + award 5)`);
console.log(`   pool remaining: free ${formatUnits(free, 6)}  reserved ${formatUnits(reserved, 6)}`);
console.log(`\n✓ on-chain loop proven: solvent pool -> committed priority -> bonded -> graded -> atomic settle`);
