/**
 * Agent 2 — the autonomous triager/payer, driven by Claude.
 *
 * Polls the queue of paid submissions, gates each on the hunter's identity and
 * history, reviews the finding on its merits, and — with no human in the loop —
 * pays the bond refund and a bounty award straight to the hunter's wallet, then
 * records the verdict with the on-chain tx hashes.
 *
 *   ANTHROPIC_API_KEY=... bun run agent/triager.ts --network testnet
 *
 * The toolkit (agent/triager-tools.ts) is framework-agnostic; this is one
 * driver. scripts/triager-flow.ts runs the same loop with a fixed policy and no
 * API key, for demos and tests.
 */
import { treasuryFromEnv } from "./treasury";
import { TRIAGER_TOOLS, type TriagerContext, type TriagerToolName } from "./triager-tools";
import { PUBLIC_URL } from "../lib/config";
import { runAgentLoop, llmConfig, describeLlm } from "../lib/llm";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;
const maxTurns = Number(arg("max-turns", "20"));

const cfg = llmConfig({ prefer: "anthropic" });
if (!cfg.apiKey) {
  console.error("No inference key (CHEAPER_INFERENCE_API_KEY or ANTHROPIC_API_KEY). Use scripts/triager-flow.ts for a keyless scripted run.");
  process.exit(1);
}
if (!cfg.model) { console.error("No model set — export INFERENCE_MODEL (see .env.example)."); process.exit(1); }
if (!process.env.ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN not set — Agent 2 is the program operator and needs it.");
  process.exit(1);
}

const ctx: TriagerContext = { treasury: treasuryFromEnv(), baseUrl, adminToken: process.env.ADMIN_TOKEN };

const SPECS = [
  { name: "get_report", description: "Fetch one report in full (summary, PoC, program, status).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "verify_submission", description: "For a COMPANY-ATTESTED bounty: fork the program repo in a sandbox, run the hunter PoC, and check the committed impact assertion. Returns proven:true/false + severity + evidence hash. Pass poc:{impact, requests[]} (from the report's stored PoC). Verify BEFORE paying.", input_schema: { type: "object", properties: { program: { type: "string" }, id: { type: "string" }, poc: { type: "object" } }, required: ["program", "id"], additionalProperties: true } },
  { name: "list_pending_reports", description: "List submissions queued for triage (bond + PoC paid), with summary and PoC.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_hunter_history", description: "The hunter's track record and tier — the identity signal for the gate.", input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"], additionalProperties: false } },
  { name: "refund_bond", description: "Refund the hunter's bond (valid or good-faith duplicate). Sends real USDC. Returns a tx hash.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "pay_award", description: "Pay a bounty award to the hunter for a valid finding. Sends real USDC, agent-to-agent. Returns a tx hash. Size the award to severity and the program's reward range.", input_schema: { type: "object", properties: { id: { type: "string" }, awardUsd: { type: "number" } }, required: ["id", "awardUsd"], additionalProperties: false } },
  { name: "rule_report", description: "Record the verdict. Pass refundTx / payoutTx / payoutUsd from the payout calls so the report carries on-chain proof the hunter was paid.", input_schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["valid", "duplicate", "out_of_scope", "slop"] }, note: { type: "string" }, refundTx: { type: "string" }, payoutUsd: { type: "number" }, payoutTx: { type: "string" } }, required: ["id", "status"], additionalProperties: false } },
];

const system = `You are the autonomous triager for the bounty402 platform — the program side of a fully
automated bug bounty. There is NO human in this loop. You review submissions and move real money.

For each pending report:
1. Pull the hunter's history (get_hunter_history). Use it as an identity gate:
   - A 'penalised' hunter (repeated slop) — be strict; reject weak findings outright.
   - A 'proven' hunter — review can be lighter, but still confirm the finding is real.
2. Review the finding against the program scope. HOW you confirm it depends on the program's
   verificationMode (in the report/program data):
   - company-attested: call verify_submission(program, id, poc) — it forks the repo, runs the
     PoC and checks the committed assertion. Trust proven:true/false; do NOT pay if unproven.
   - onchain-fork: the PoC is executed against a chain fork by the impact harness; confirm the
     proven impact and severity.
   Decide one of: valid, duplicate, out_of_scope, slop.
3. Pay accordingly, then record the verdict:
   - valid: refund_bond, then pay_award (size the award to severity and the reward range),
     then rule_report(status=valid) passing refundTx, payoutTx and payoutUsd.
   - duplicate (good faith): refund_bond, then rule_report(status=duplicate, refundTx).
   - out_of_scope / slop: do NOT refund; rule_report with that status and a one-line reason.

You are spending a real treasury. Do not pay awards for findings you are not convinced are real
and in scope. When the queue is empty, stop and summarise what you ruled and paid.`;

console.log(`triager agent  treasury=${ctx.treasury.address}  base=${baseUrl}`);
console.log(`inference: ${describeLlm(cfg)}\n`);

await runAgentLoop({
  cfg,
  system,
  userText: "Triage the queue. Start with list_pending_reports.",
  tools: SPECS as any,
  maxTurns,
  onText: (t) => console.log(`\n${t}\n`),
  onToolCall: (name, input) => console.log(`  \u2192 ${name}(${JSON.stringify(input).slice(0, 120)})`),
  runTool: async (name, input) => {
    const fn = (TRIAGER_TOOLS as any)[name] as (c: TriagerContext, a?: any) => any;
    if (!fn) return { error: `unknown tool: ${name}` };
    return fn(ctx, input);
  },
});
console.log("\n\u2500\u2500 triager finished \u2500\u2500");
