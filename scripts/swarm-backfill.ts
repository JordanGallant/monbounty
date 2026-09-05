/**
 * Publish every existing program's canonical rules to Swarm and record the
 * reference + ENS name. Idempotent: skips programs that already round-trip
 * correctly. Run once after adding the Swarm/ENS layer.
 *
 *   bun run scripts/swarm-backfill.ts
 *   bun run scripts/swarm-backfill.ts --force   # re-upload even if a ref exists
 */
import { ready, db, getProgramRow, setProgramSwarm, type ProgramRow } from "../lib/db";
import { canonicalRules, rulesHash, type BountyRules } from "../lib/rules";
import { swarmUpload, swarmVerify } from "../lib/swarm";
import { programEnsName } from "../lib/ens";

const force = process.argv.includes("--force");

function rulesFromRow(p: ProgramRow): BountyRules {
  return {
    slug: p.slug, name: p.name, target: p.target ?? "",
    scopeIn: JSON.parse(p.scope_in ?? "[]"), scopeOut: JSON.parse(p.scope_out ?? "[]"),
    payouts: JSON.parse(p.payouts ?? "{}"), bondUsd: p.bond_usd,
    acceptedImpacts: JSON.parse(p.accepted_impacts ?? "[]"),
    slaSeconds: p.sla_seconds ?? 0, ruler: p.ruler ?? "",
  };
}

await ready;
const rows = await db.query<ProgramRow, []>(
  "SELECT * FROM programs WHERE rules_hash IS NOT NULL ORDER BY created_at").all();

console.log(`Found ${rows.length} committed program(s).`);
for (const p of rows) {
  const ens = programEnsName(p.slug);
  if (p.rules_swarm_ref && !force) {
    try {
      const v = await swarmVerify(p.rules_swarm_ref, p.rules_hash!);
      if (v.ok) { console.log(`  ✓ ${p.slug} already on Swarm (${p.rules_swarm_ref.slice(0, 12)}…)`); continue; }
    } catch { /* fall through and re-upload */ }
  }
  const rules = rulesFromRow(p);
  const hash = rulesHash(rules);
  if (hash.toLowerCase() !== p.rules_hash!.toLowerCase()) {
    console.warn(`  ! ${p.slug}: recomputed rulesHash != stored (${hash} != ${p.rules_hash}); uploading anyway`);
  }
  const up = await swarmUpload(canonicalRules(rules), {
    filename: `${p.slug}.rules.json`, contentType: "application/json",
  });
  await setProgramSwarm(p.slug, up.reference, ens);
  const match = up.contentHash.toLowerCase() === p.rules_hash!.toLowerCase();
  console.log(`  ${match ? "✓" : "✗"} ${p.slug} -> swarm ${up.reference.slice(0, 12)}… (${up.bytes}B) ens ${ens} match=${match}`);
}
console.log("Done.");
process.exit(0);
