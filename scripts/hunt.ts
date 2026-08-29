/**
 * hunt.ts — drive a paid submission from a session-generated wallet.
 *
 * A fresh agent (e.g. a new Claude Code session) can't do EIP-3009 signing over
 * raw curl, so this runs the toolkit's submit path with a key the agent made
 * itself (via create_wallet). It pays the bond + PoC gate over x402 and files.
 *
 *   # after create_wallet gave you a key + the human funded the address:
 *   HUNTER_PRIVATE_KEY=0x... bun run scripts/hunt.ts \
 *     --program monbounty-infra \
 *     --finding '{"title":"IDOR ...","severity":"high","asset":"/api/users/:id","summary":"..."}' \
 *     --poc '{"impact":"web-idor","requests":[{"path":"/api/users/2"}]}'
 *
 * Omit --finding/--poc to use the built-in IDOR demo. If the wallet is unfunded
 * it prints exactly what to send and stops.
 */
import { AgentWallet } from "../agent/wallet";
import * as T from "../agent/tools";
import type { ToolContext } from "../agent/tools";
import { PUBLIC_URL, type NetKey } from "../lib/config";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const key = arg("key", process.env.HUNTER_PRIVATE_KEY);
if (!key) { console.error("Provide --key or HUNTER_PRIVATE_KEY (from create_wallet)."); process.exit(1); }
const program = arg("program", "monbounty-infra")!;
const network = arg("network", "testnet") as NetKey;
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;

const ctx: ToolContext = { wallet: new AgentWallet(key!), privateKey: key!, baseUrl, network };
const step = (n: string) => console.log(`\n── ${n} ──`);
const show = (x: any) => console.log(JSON.stringify(x, null, 1));

const finding = {
  program,
  ...(arg("finding")
    ? JSON.parse(arg("finding")!)
    : {
        title: "IDOR: /api/users/:id returns another tenant's apiSecret without auth",
        severity: "high",
        asset: "/api/users/:id",
        summary:
          "The user endpoint returns any user record — including their apiSecret — for an arbitrary id " +
          "with no authorization check. Requesting another user's id leaks their secret (broken access control).",
      }),
};
const poc = arg("poc") ?? JSON.stringify({ impact: "web-idor", requests: [{ path: "/api/users/2" }] });

console.log(`hunt  wallet=${ctx.wallet.address}  program=${program}  network=${network}`);
step("check_wallet"); show(await T.check_wallet(ctx));

step("submit_finding (pays bond over x402)");
const sub = await T.submit_finding(ctx, finding);
show(sub);
if (!sub.paid) {
  if (sub.insufficientFunds || !sub.id) {
    step("needs funding");
    const fr = await T.request_funding(ctx, { needUsd: 5, reason: finding.title, program });
    console.log(`Fund ${ctx.wallet.address} with USDC on ${network}, then re-run. Details:`);
    show(fr);
  }
  process.exit(0);
}

step("submit_poc (pays second gate)");
show(await T.submit_poc(ctx, { id: sub.id, poc }));

step("check_report");
show(await T.check_report(ctx, { id: sub.id }));
console.log("\n✓ submitted — the company agent will verify and settle.");
