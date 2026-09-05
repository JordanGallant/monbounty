// Drive the hunter through the acme-pay-demo web2 bounty, end to end, using the
// same tools the LLM agent has. Submits the IDOR finding + a structured PoC that
// the company's verifier can replay against the Acme Pay target.
//
//   HUNTER_PRIVATE_KEY=0x… BOUNTY402_URL=http://127.0.0.1:3044 \
//     bun run demo/hunter/hunt.ts --network testnet
//
import { walletFromEnv } from "../../agent/wallet";
import * as T from "../../agent/tools";
import type { ToolContext } from "../../agent/tools";
import { PUBLIC_URL, type NetKey } from "../../lib/config";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const program = arg("program", "acme-pay-demo")!;
const network = arg("network", "testnet") as NetKey;
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;
const ctx: ToolContext = { wallet: walletFromEnv(), privateKey: process.env.HUNTER_PRIVATE_KEY!, baseUrl, network };

const step = (s: string) => console.log(`\n── ${s} ──`);
const show = (x: any) => console.log(JSON.stringify(x, null, 1));

const finding = {
  program,
  title: "IDOR: /api/accounts/:id returns another account's data (incl. service API key)",
  severity: "high" as const,
  asset: "/api/accounts/:id",
  summary:
    "The accounts endpoint returns any account record by id with no ownership check. Requesting " +
    "/api/accounts/1001 (the internal service account) while logged in as another account leaks its " +
    "live API key — a broken-object-level-authorization (IDOR) exposing a sensitive secret.",
};
const poc = JSON.stringify({ impact: "web-idor", requests: [{ method: "GET", path: "/api/accounts/1001" }] });

console.log(`hunter  wallet=${ctx.wallet.address}  program=${program}  network=${network}  base=${baseUrl}`);

step("get_scope"); show(await T.get_scope(ctx, { slug: program }));

step("draft_writeup");
const draft = T.draft_writeup(ctx, finding);
show(draft);
if (!draft.ok) process.exit(1);

step("submit_finding (pays bond over x402)");
const sub = await T.submit_finding(ctx, finding);
show(sub);
if (!sub.paid || !sub.id) { console.log("submit failed"); process.exit(1); }

step("submit_poc (pays the PoC gate over x402)");
show(await T.submit_poc(ctx, { id: sub.id, poc }));

step("check_report");
show(await T.check_report(ctx, { id: sub.id }));
console.log(`\n✓ submission complete — report ${sub.id} is queued for the company's triager.`);
console.log(`  next: the triager verifies (clones the target, replays the PoC) and settles.`);
process.exit(0);
