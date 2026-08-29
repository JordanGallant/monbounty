/**
 * Scripted hunter-agent flow — the same tools agent.ts gives Claude, run in a
 * fixed order with no LLM and no API key. Use it to demo (or test) the full
 * self-funding loop deterministically:
 *
 *   check wallet -> reputation -> programs -> draft -> afford? ->
 *   (request funding + wait) -> submit bond -> submit PoC -> check status
 *
 *   bun run scripts/agent-flow.ts --program monad-escrow-demo --network testnet
 *
 * It completes end-to-end the moment the wallet holds enough USDC; until then it
 * stops at the funding step and prints exactly what a human must send.
 */
import { walletFromEnv } from "../agent/wallet";
import * as T from "../agent/tools";
import type { ToolContext } from "../agent/tools";
import { PUBLIC_URL, type NetKey } from "../lib/config";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const program = arg("program", "monbounty-infra")!;
const network = arg("network", "testnet") as NetKey;
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;
const waitSec = Number(arg("wait", "0")); // set >0 to actually block for funding

const ctx: ToolContext = { wallet: walletFromEnv(), privateKey: process.env.HUNTER_PRIVATE_KEY!, baseUrl, network };
const step = (n: string) => console.log(`\n── ${n} ──`);
const show = (x: any) => console.log(JSON.stringify(x, null, 1));

const finding = {
  program,
  title: "IDOR: /api/users/:id returns another tenant's apiSecret without auth",
  severity: "high" as const,
  asset: "/api/users/:id",
  summary:
    "The user endpoint returns any user record — including their apiSecret — for an arbitrary id " +
    "with no authorization check. Requesting /api/users/2 while unauthenticated (or as a different " +
    "user) leaks user 2's secret, a broken-access-control / IDOR exposing sensitive data.",
};
// Structured PoC so the company agent can replay it in verify_submission:
// impact id + the request sequence that demonstrates it.
const poc = JSON.stringify({ impact: "web-idor", requests: [{ path: "/api/users/2" }] });

console.log(`hunter agent (scripted)  wallet=${ctx.wallet.address}  program=${program}  network=${network}`);

step("check_wallet");        show(await T.check_wallet(ctx));
step("get_my_reputation");   show(await T.get_my_reputation(ctx));
step("list_programs");       show(await T.list_programs(ctx));
step("get_scope");           show(await T.get_scope(ctx, { slug: program }));

step("draft_writeup");
const draft = T.draft_writeup(ctx, finding);
show(draft);
if (!draft.ok) process.exit(1);

// figure out the quoted price for this hunter
const progs = await T.list_programs(ctx);
const p = progs.programs.find((x: any) => x.slug === program);
const rep = await T.get_my_reputation(ctx);
const bondQuote = (p?.bondUsd ?? 1) * (rep.bondMultiplier ?? 1);
const pocQuote = (p?.pocBondUsd ?? 4) * (rep.bondMultiplier ?? 1);
const total = bondQuote + pocQuote;

step("check affordability");
const afford = await ctx.wallet.canAfford(total, network);
show({ ...afford, bondQuote, pocQuote, total });

if (!afford.ok) {
  step("request_funding");
  const fr = await T.request_funding(ctx, { needUsd: total, reason: `bond+PoC for: ${finding.title}`, program });
  show(fr);
  if (waitSec > 0) {
    step(`wait_for_funding (up to ${waitSec}s — fund the wallet now)`);
    const w = await T.wait_for_funding(ctx, { needUsd: total, requestId: fr.id, timeoutSec: waitSec });
    show(w);
    if (!w.funded) { console.log("\nNot funded in time — stopping. Re-run to continue."); process.exit(0); }
  } else {
    console.log("\nWallet can't cover the bond. Fund it, then re-run (or pass --wait 600 to block here).");
    process.exit(0);
  }
}

step("submit_finding (pays bond over x402)");
const sub = await T.submit_finding(ctx, finding);
show(sub);
if (!sub.paid || !sub.id) process.exit(1);

step("submit_poc (pays second gate)");
const pc = await T.submit_poc(ctx, { id: sub.id, poc });
show(pc);

step("check_report");
show(await T.check_report(ctx, { id: sub.id }));
console.log("\n✓ full self-funding submission complete");
