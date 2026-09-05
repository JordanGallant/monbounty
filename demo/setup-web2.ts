// Register the local "Acme Pay" vulnerable target as a monbounty web2 bounty.
// Idempotent — safe to re-run. The program verifies submissions in
// `company-attested` mode: the triager clones the local target repo, runs it,
// replays the hunter's PoC, and checks the committed assertion.
//
//   bun run demo/setup-web2.ts
//
// Then a hunter (Claude session) can work `acme-pay-demo` against the local
// target on 127.0.0.1 and the whole loop settles on Monad testnet.

import { ready, getProgramRow, createBountyProgram, setProgramApproval, recordProgramFunding } from "../lib/db";
import type { BountyRules } from "../lib/rules";

const SLUG = "acme-pay-demo";
// Company/ruler wallet — the funded Monad testnet treasury that grades + pays.
const RULER = (process.env.DEMO_RULER ?? "0x7266863ec3a376655dc29b4b0021b5c09758cec0").toLowerCase();
const TARGET_REPO = process.env.DEMO_TARGET_REPO ?? "/opt/bounty402/demo/target";

const rules: BountyRules = {
  slug: SLUG,
  name: "Acme Pay — API security bounty (demo)",
  target: "Acme Pay API (local demo target, 127.0.0.1)",
  scopeIn: [
    "GET /api/accounts/:id — account data access",
    "GET /api/me — session account",
    "Any endpoint that returns data belonging to another account",
  ],
  scopeOut: ["Denial of service", "Social engineering", "The monbounty platform itself"],
  // Demo-sized so a lightly-funded testnet treasury can actually pay the award
  // on-chain. Bump these for a mainnet program.
  payouts: { critical: 25, high: 8, medium: 3, low: 1, informational: 0 },
  bondUsd: 1,
  acceptedImpacts: ["web-idor", "web-auth-bypass", "web-secret-exposure", "web-sensitive-data"],
  slaSeconds: 3 * 24 * 3600,
  ruler: RULER,
};

const recipe = {
  repo: TARGET_REPO,
  runCmd: "bun run server.ts",
  port: 4599,
  healthPath: "/",
  bootSec: 20,
  // The committed proof: reading another account's live-looking API key.
  assertions: { "web-idor": "sk_live_.*LEAKED", "web-secret-exposure": "sk_live_.*LEAKED" },
};

await ready;
const existing = await getProgramRow(SLUG);
if (existing) {
  console.log(`Program ${SLUG} already exists (${existing.approval_status}). Nothing to do.`);
  process.exit(0);
}

const { rulesHash, swarmRef, ensName } = await createBountyProgram(rules, {
  bondUsd: rules.bondUsd,
  contact: "security@acme.demo",
  createdBy: "demo@monbounty.xyz",
  verificationMode: "company-attested",
  verifyRecipe: recipe,
});
await setProgramApproval(SLUG, "approved", "demo-setup");
await recordProgramFunding(SLUG, 8000); // fund the reward pool so it's solvent

console.log(`✓ Created bounty ${SLUG}`);
console.log(`  rulesHash: ${rulesHash}`);
console.log(`  swarm:     ${swarmRef ?? "(pending)"} ${ensName ? `ens ${ensName}` : ""}`);
console.log(`  target:    ${TARGET_REPO} (company-attested verify)`);
console.log(`  program:   http://127.0.0.1:3044/api/programs/${SLUG}/rules`);
console.log(`\nNext: start the target →  PORT=4600 bun run demo/target/server.ts`);
console.log(`Then run the hunter session (see demo/README.md).`);
process.exit(0);
