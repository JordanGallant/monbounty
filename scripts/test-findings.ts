/**
 * Exercises the write-up + submission tools with REAL findings produced by
 * analysing contracts/demo-target/VaultBank.sol. Stands in for the bug-finding
 * agent: the three findings below are the analysis output; this script pushes
 * them through draft_writeup (validation) and submit_finding (the x402 pipeline).
 *
 *   bun run scripts/test-findings.ts --network testnet
 */
import { walletFromEnv } from "../agent/wallet";
import * as T from "../agent/tools";
import type { ToolContext, Finding } from "../agent/tools";
import { PUBLIC_URL, type NetKey } from "../lib/config";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const network = arg("network", "testnet") as NetKey;
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;
const ctx: ToolContext = { wallet: walletFromEnv(), privateKey: process.env.HUNTER_PRIVATE_KEY!, baseUrl, network };

const PROGRAM = "vaultbank";

// The bug-finding agent's output over VaultBank.sol.
const findings: (Finding & { inScope: boolean; why: string })[] = [
  {
    program: PROGRAM,
    title: "Reentrancy in withdraw() lets a hooked token drain the vault",
    severity: "critical",
    asset: "contracts/demo-target/VaultBank.sol:withdraw",
    summary:
      "withdraw() calls token.transfer(msg.sender, amount) BEFORE decrementing balance[msg.sender] " +
      "and totalDeposited. With a token that has a transfer hook (ERC-777 / callback-on-transfer), the " +
      "recipient re-enters withdraw() while its recorded balance is still the full amount, and repeats " +
      "until the vault is empty. Fix: apply checks-effects-interactions — decrement balance before the " +
      "external transfer, or add a nonReentrant guard.",
    inScope: true,
    why: "reentrancy / fund-draining — explicitly in scope",
  },
  {
    program: PROGRAM,
    title: "onlyOwner checks tx.origin, allowing a phishing bypass of sweep()",
    severity: "high",
    asset: "contracts/demo-target/VaultBank.sol:onlyOwner",
    summary:
      "The onlyOwner modifier requires tx.origin == owner instead of msg.sender == owner. If the owner is " +
      "induced to call any malicious contract, that contract can call sweep()/accrue() in the same tx while " +
      "tx.origin is still the owner, passing the check. sweep(attacker) then drains the entire token balance. " +
      "Fix: compare msg.sender, never tx.origin, for authorisation.",
    inScope: true,
    why: "access control / fund-draining — in scope",
  },
  {
    program: PROGRAM,
    title: "accrue() loses interest for balances under 100 via divide-before-multiply",
    severity: "low",
    asset: "contracts/demo-target/VaultBank.sol:accrue",
    summary:
      "accrue() computes (balance / 10_000) * rateBps, dividing before multiplying, so any balance below " +
      "10_000/rateBps accrues zero interest and precision is silently lost. Should multiply before dividing. " +
      "Noted for completeness though the program excludes rounding issues.",
    inScope: false,
    why: "rounding/precision — OUT of scope for this program",
  },
];

const line = (s = "") => console.log(s);
line(`bug-finding agent → ${PROGRAM}   wallet=${ctx.wallet.address}\n`);

// 1) draft_writeup on every finding — proves validation and scope judgement
line("STEP 1 — draft_writeup (validate each finding)\n");
const toSubmit: Finding[] = [];
for (const f of findings) {
  const d = T.draft_writeup(ctx, f);
  const tag = d.ok ? "OK  " : "FAIL";
  line(`  [${tag}] ${f.severity.padEnd(8)} ${f.title}`);
  line(`         scope: ${f.inScope ? "IN" : "OUT"} — ${f.why}`);
  if (!d.ok) line(`         problems: ${d.problems.join("; ")}`);
  // Agent judgement: only submit in-scope, well-formed findings.
  if (d.ok && f.inScope) toSubmit.push(d.finding);
  else if (!f.inScope) line(`         → withholding (out of scope protects reputation)`);
}

// 1b) negative control: a deliberately malformed writeup must be rejected
line("\nSTEP 1b — draft_writeup rejects a malformed writeup (negative control)");
const bad = T.draft_writeup(ctx, { program: PROGRAM, title: "bug", severity: "critical", summary: "too short" });
line(`  ${JSON.stringify(bad)}`);

// 2) submit_finding — runs the full x402 signing + payment pipeline
line(`\nSTEP 2 — submit_finding for ${toSubmit.length} in-scope finding(s) (x402 pipeline)\n`);
for (const f of toSubmit) {
  const res = await T.submit_finding(ctx, f);
  if (res.paid) {
    line(`  PAID   ${f.title}`);
    line(`         id=${res.id} status=${res.status} bond=$${res.bondUsd}`);
    if (res.nextStep) line(`         next: pay $${res.nextStep.priceUsd} PoC gate at ${res.nextStep.url}`);
  } else if (res.insufficientFunds) {
    line(`  QUOTED ${f.title}`);
    line(`         wallet empty → x402 signed and challenged; needs $${res.quotedUsd} USDC to complete`);
  } else {
    line(`  ERR    ${f.title}: ${JSON.stringify(res).slice(0, 160)}`);
  }
}

line(`\nSummary: analysed 3 issues, ${toSubmit.length} submitted (in scope), 1 withheld (out of scope).`);
line("The bond gate means submitting the out-of-scope finding would have cost money for nothing —");
line("the agent's scope judgement is worth real USDC.");
