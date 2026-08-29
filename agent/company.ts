/**
 * Reference company agent: onboards a bug bounty, driven by Claude.
 *
 * You hand it a target (a contract, a system, a description). It reads the code,
 * writes impact-based scope, proposes a payout table for a human to price,
 * provisions a wallet, creates the bounty — committing the rulesHash so the
 * rules cannot move — funds the reward pool, and verifies the result.
 *
 *   ANTHROPIC_API_KEY=... bun run agent/company.ts \
 *     --target ./contracts/demo-target/LeakyVault.sol --slug leaky-vault
 *
 * The toolkit (agent/company-tools.ts) is framework-agnostic; this is one
 * driver. scripts/company-flow.ts runs the same tools with no API key.
 */
import { COMPANY_TOOLS, type CompanyContext, type CompanyToolName } from "./company-tools";
import { COMPANY_TOOL_SPECS } from "./company-toolspecs";
import { PUBLIC_URL, type NetKey } from "../lib/config";
import { runAgentLoop, llmConfig, describeLlm } from "../lib/llm";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const target = arg("target");
const slug = arg("slug");
const network = arg("network", "testnet") as NetKey;
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;
const ruler = arg("ruler", process.env.TREASURY_ADDRESS ?? "")!;
const poolUsd = Number(arg("pool", "0")); // >0 to let the agent fund confirmed
const maxTurns = Number(arg("max-turns", "16"));

const cfg = llmConfig({ prefer: "anthropic" });
if (!cfg.apiKey) {
  console.error(
    "No inference key set. The toolkit runs without an LLM (see scripts/company-flow.ts for a\n" +
    "scripted, deterministic demo); this model-driven loop needs CHEAPER_INFERENCE_API_KEY or\n" +
    "ANTHROPIC_API_KEY. Export one and re-run.",
  );
  process.exit(1);
}
if (!cfg.model) {
  console.error(
    `No model set for ${cfg.provider}. Export INFERENCE_MODEL to the exact model id your gateway\n` +
    "serves (see .env.example), then re-run. Nothing is called until a model is chosen.",
  );
  process.exit(1);
}
if (!ruler) {
  console.error("Set --ruler 0x... or TREASURY_ADDRESS: the company needs a grading/funding wallet.");
  process.exit(1);
}

const ctx: CompanyContext = { baseUrl, network, ruler };

const system = `You are onboarding a bug bounty program onto bounty402, on behalf of a company.

Your job: turn a target into a live, trustworthy bounty an autonomous hunter can rely on.

What makes a bounty trustworthy here — and what you must get right:
- SCOPE must be concrete and impact-based. Read the target first. Say what is in scope and what
  is out, in the company's own terms.
- SEVERITY is not yours to invent. Pull the impact catalogue with list_impacts and choose the
  impact ids the program will pay for. The severity band follows from the impact.
- PRICES are the human's decision. Use propose_payouts to suggest a table (from the TVL or a
  preset), but present it as a proposal. The table must be monotonic — critical >= high >= ... .
- Nothing is committed until create_bounty. Always draft_bounty first and show the human the
  rulesHash it will lock in — after that, the scope and payouts cannot move, which is the entire
  point: a hunter can trust them.
- A bounty with no money is worthless. provision_wallet, create_bounty, then fund_pool. Only set
  confirmed:true on funding you were told is actually sent.
- Finish with verify_bounty and report the slug, the rulesHash, and whether it is solvent.

Work the tools until the bounty is created, funded and verified — or until you need a human
decision on prices or funding, in which case stop and ask clearly.${
  poolUsd > 0 ? `\n\nYou are authorised to fund the reward pool with $${poolUsd} (confirmed).` : ""
}`;

console.log(`company agent  ruler=${ruler}  network=${network}  base=${baseUrl}`);
console.log(`inference: ${describeLlm(cfg)}\n`);

await runAgentLoop({
  cfg,
  system,
  userText:
    `Onboard a bounty${slug ? ` with slug "${slug}"` : ""} for this target: ${target ?? "(described below)"}.\n` +
    `Network: ${network}. Grading/funding wallet (ruler): ${ruler}.\n\n` +
    `Begin by reading the target and the impact catalogue.`,
  tools: COMPANY_TOOL_SPECS as any,
  maxTurns,
  onText: (t) => console.log(`\n${t}\n`),
  onToolCall: (name, input) => console.log(`  \u2192 ${name}(${JSON.stringify(input).slice(0, 120)})`),
  runTool: async (name, input) => {
    const fn = (COMPANY_TOOLS as any)[name] as (c: CompanyContext, a?: any) => any;
    if (!fn) return { error: `unknown tool: ${name}` };
    return fn(ctx, input);
  },
});

console.log("\n\u2500\u2500 agent finished \u2500\u2500");
