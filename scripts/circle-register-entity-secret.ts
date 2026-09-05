/**
 * One-time: generate + register the Circle entity secret (the 2nd secret Circle
 * developer-controlled wallets need beyond the API key). Prints the secret to
 * add to .env and writes the RECOVERY FILE Circle returns — keep it: it is the
 * only way to recover the entity secret if lost.
 *
 *   bun run scripts/circle-register-entity-secret.ts
 */
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";
import { writeFileSync } from "node:fs";

const API_KEY = process.env.CIRCLE_API_KEY;
if (!API_KEY) { console.error("CIRCLE_API_KEY not set"); process.exit(1); }
if (process.env.CIRCLE_ENTITY_SECRET) {
  console.error("CIRCLE_ENTITY_SECRET already set — an entity secret is likely already registered. Aborting to avoid a conflicting re-register.");
  process.exit(1);
}

// 32 random bytes as hex = the entity secret (yours, kept private).
const entitySecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

console.log("registering entity secret with Circle (sandbox)…");
const res = await registerEntitySecretCiphertext({ apiKey: API_KEY, entitySecret });
const recovery = res?.data?.recoveryFile;
if (!recovery) { console.error("registration returned no recovery file:", JSON.stringify(res)); process.exit(1); }

const recPath = "/opt/bounty402/circle-entity-secret-recovery.dat";
writeFileSync(recPath, recovery, { mode: 0o600 });

console.log("\n✓ registered.");
console.log(`  recovery file written to ${recPath} (chmod 600) — BACK THIS UP; it recovers the secret if lost.`);
console.log("\nAdd this to /opt/bounty402/.env:\n");
console.log(`CIRCLE_ENTITY_SECRET=${entitySecret}`);
