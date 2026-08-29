/**
 * Scripted company-agent flow — the same tools agent/company.ts gives Claude,
 * run in a fixed order with no LLM and no API key. Onboards a bounty end to end:
 *
 *   read target -> impact catalogue -> propose payouts -> draft (hash preview)
 *   -> provision wallet -> create bounty -> fund pool -> verify (hash + solvent)
 *
 *   bun run scripts/company-flow.ts --target contracts/demo-target/LeakyVault.sol
 *
 * Deterministic: good for demos and as a smoke test of the whole company side.
 */
import * as C from "../agent/company-tools";
import type { CompanyContext } from "../agent/company-tools";
import { PUBLIC_URL, type NetKey } from "../lib/config";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const target = arg("target", "contracts/demo-target/LeakyVault.sol")!;
const network = arg("network", "testnet") as NetKey;
const baseUrl = arg("base", process.env.BOUNTY402_URL ?? PUBLIC_URL)!;
const slug = arg("slug", "leaky-vault-" + Math.random().toString(36).slice(2, 7))!;
const ruler = arg("ruler", process.env.TREASURY_ADDRESS ?? "0x7266863EC3A376655dc29B4B0021B5C09758cEC0")!;

const ctx: CompanyContext = { baseUrl, network, ruler };
const step = (n: string) => console.log(`\n── ${n} ──`);
const show = (x: any) => console.log(JSON.stringify(x, null, 1));

const draft: C.BountyDraft = {
  slug,
  name: "LeakyVault",
  target,
  scopeIn: ["missing access control", "direct theft of vault funds", "reentrancy"],
  scopeOut: ["gas optimisation", "centralisation of the deployer key"],
  acceptedImpacts: ["theft-user-funds", "permanent-freeze", "insolvency", "griefing"],
  payouts: { critical: 50000, high: 10000, medium: 5000, low: 1000, informational: 0 },
  slaSeconds: 7 * 24 * 3600,
  bondUsd: 1,
  tvlUsd: 500000,
};

step("read target");
const t = C.read_target(ctx, { path: target });
console.log(t.error ? t : `${t.source}: ${t.length} bytes`);

step("impact catalogue (agent reads the taxonomy)");
const impacts = await C.list_impacts(ctx);
console.log(`${impacts.impacts?.length} impacts, ${impacts.machineCheckable?.length} machine-checkable`);

step("propose payouts (from TVL; human confirms)");
show(await C.propose_payouts(ctx, { preset: "onchain", tvlUsd: draft.tvlUsd }));

step("draft bounty (validate + hash preview, nothing committed)");
const d = await C.draft_bounty(ctx, draft);
show(d);
if (!d.ok) { console.log("draft invalid — stopping"); process.exit(1); }

step("provision company wallet");
show(await C.provision_wallet(ctx, { label: "leakyvault-co" }));

step("create bounty (commits rulesHash on record)");
const created = await C.create_bounty(ctx, draft);
show(created);
if (!created.slug) { console.log("create failed — stopping"); process.exit(1); }

step("fund reward pool (confirmed)");
show(await C.fund_pool(ctx, { amountUsd: draft.payouts.critical, confirmed: true }));

step("verify: hash matches + pool solvent");
const v = await C.verify_bounty(ctx);
console.log(JSON.stringify({ verified: v.verified, rulesHash: v.rulesHash, solvent: v.pool?.solvent, impacts: v.impacts?.length }, null, 1));

console.log(`\n✓ bounty '${created.slug}' is live, hash-verified and solvent — hunters can now discover it at ${baseUrl}/api/programs`);
