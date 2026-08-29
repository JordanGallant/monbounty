/**
 * Reference hunter agent: an autonomous agent that can hack, driven by Claude.
 *
 * You hand it a target (scope + the code/notes it should analyse). It reasons
 * about vulnerabilities using its own tools, checks its wallet, writes findings
 * up, pays the bond over x402, and — when it runs out of money — asks a human
 * for funding and waits. The human never sees the private key; they just top up
 * the wallet address the agent gives them.
 *
 *   ANTHROPIC_API_KEY=... bun run agent/agent.ts \
 *     --program monad-escrow-demo --network testnet --target ./contracts/SubmissionRegistry.sol
 *
 * The toolkit (agent/tools.ts) is framework-agnostic; this file is just one
 * driver. Swap Claude for any tool-calling model and the tools are unchanged.
 */
import { readFileSync } from "node:fs";
import { walletFromEnv } from "./wallet";
import { TOOLS, type ToolContext, type ToolName } from "./tools";
import { TOOL_SPECS } from "./toolspecs";
import { PUBLIC_URL, type NetKey } from "../lib/config";
import { runAgentLoop, llmConfig, describeLlm } from "../lib/llm";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const program = arg("program", "monad-escrow-demo")!;
const network = (arg("network", "testnet") as NetKey);
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;
const targetPath = arg("target");
const maxTurns = Number(arg("max-turns", "16"));

const cfg = llmConfig();
if (!cfg.apiKey) {
  console.error(
    "No inference key set. The toolkit runs without an LLM (see scripts/agent-flow.ts for a\n" +
    "scripted demo); this model-driven loop needs CHEAPER_INFERENCE_API_KEY or ANTHROPIC_API_KEY.",
  );
  process.exit(1);
}
if (!cfg.model) {
  console.error("No model set. Export INFERENCE_MODEL to your gateway's model id (see .env.example).");
  process.exit(1);
}

const wallet = walletFromEnv();
const ctx: ToolContext = { wallet, privateKey: process.env.HUNTER_PRIVATE_KEY!, baseUrl, network };

const target = targetPath ? readFileSync(targetPath, "utf8") : "(no target file supplied — reason from the program scope only)";

const system = `You are an autonomous security researcher with your own crypto wallet on Monad.

Your job: get onboarded, choose a bounty WITH THE HUMAN, read its scope, make a plan, then find
a real in-scope vulnerability and submit it, paying the bond yourself over x402.

Onboarding order:
1. check_wallet and get_my_reputation.
1b. register_identity — REQUIRED before you can submit. monbounty blocks submissions from wallets
   with no ERC-8004 identity. If it returns needsGas, tell the human the exact address to send a
   little testnet MON to, wait, then register again. Do this once, up front.
2. list_programs. Present the open bounties to the human — name, type, max bounty, submission
   price, whether the pool is funded — and ASK which one they want to work on. Do not choose for
   them. (If a program "${program}" was pre-selected on the command line, still confirm it.)
3. get_scope(slug) for the chosen program. Read scopeIn/scopeOut, the impacts, and which are
   pocProvable. Prefer a pocProvable impact — its severity and payout are settled by executing the
   PoC, not argued.
4. Make a short plan: the one impact you will target and how you will demonstrate it. Then hunt.

Rules that matter:
- Only submit findings you genuinely believe are real AND in scope. The bond is SLASHED for
  slop, hallucinated bugs, and out-of-scope reports, and that permanently raises your future
  bond. A rejected finding costs you money.
- Always draft_writeup before submit_finding — it catches format problems that would waste a bond.
- Before paying, check_wallet. If you cannot afford the bond, request_funding with a clear
  reason, then wait_for_funding, then retry. Do not give up just because the wallet is empty.
- After submit_finding succeeds, pay the PoC gate with submit_poc — a report is not queued for
  a human until you do.
- Prefer one strong finding over several weak ones. Quality is literally priced in.

Work the tools until you have either submitted a finding (bond + PoC paid) or determined there
is nothing real to report. Then stop and summarise what you did and what it cost.`;

console.log(`hunter agent  wallet=${wallet.address}  program=${program}  network=${network}`);
console.log(`inference: ${describeLlm(cfg)}\n`);

await runAgentLoop({
  cfg,
  system,
  userText:
    `Program: ${program}\nNetwork: ${network}\n\n` +
    `Target under analysis:\n\`\`\`\n${target.slice(0, 60_000)}\n\`\`\`\n\n` +
    `Begin. Start by checking the program scope, your wallet, and your reputation.`,
  tools: TOOL_SPECS as any,
  maxTurns,
  onText: (t) => console.log(`\n${t}\n`),
  onToolCall: (name, input) => console.log(`  \u2192 ${name}(${JSON.stringify(input).slice(0, 120)})`),
  runTool: async (name, input) => {
    const fn = (TOOLS as any)[name] as (c: ToolContext, a?: any) => any;
    if (!fn) return { error: `unknown tool: ${name}` };
    return fn(ctx, input);
  },
});

console.log("\n\u2500\u2500 agent finished \u2500\u2500");
