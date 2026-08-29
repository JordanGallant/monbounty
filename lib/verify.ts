// Company-side verification for off-chain / private-code bounties.
//
// The company's own agent forks its repo into a throwaway working copy, builds
// and runs it, replays the hunter's PoC against that fresh deploy, and checks a
// committed impact assertion. The hunter never sees the code; only a signed
// verdict + evidence hash leaves the sandbox. This is the web2 analog of
// forking the chain and running a Foundry PoC against an invariant.
//
// SAFETY: for the demo this runs in a temp dir with timeouts. The PoC is a list
// of HTTP requests (not an arbitrary script), so only the company's OWN code
// runs; the hunter's input is just requests. Production should wrap this in a
// real isolated sandbox (Firecracker / Vercel Sandbox) — the interface is the same.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface VerifyRecipe {
  repo: string;            // git URL (public for the demo; a private clone token in prod)
  ref?: string;            // branch or commit
  buildCmd?: string;       // e.g. "bun install" / "npm ci"
  runCmd?: string;         // e.g. "bun run server.js" — starts the app, honours $PORT
  port?: number;           // the port the app listens on
  healthPath?: string;     // path polled for readiness (default "/")
  bootSec?: number;        // how long to wait for boot (default 25)
}

export interface PocRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Poc {
  impact: string;          // claimed impact id (from the catalogue)
  requests: PocRequest[];  // the reproduction, replayed in order
  assertion: string;       // regex the combined responses must match to prove impact
}

export interface VerifyResult {
  proven: boolean;
  impact: string;
  assertionMatched: boolean;
  transcript: { request: string; status: number; bodySnippet: string }[];
  evidenceHash: string;
  log: string[];
  error?: string;
}

const sh = (cmd: string, cwd: string, timeoutMs: number) =>
  Bun.spawn(["bash", "-lc", cmd], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });

async function waitPort(url: string, deadline: number, log: string[]): Promise<boolean> {
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {}
    await Bun.sleep(600);
  }
  log.push(`app did not become ready at ${url}`);
  return false;
}

export async function verifySubmission(recipe: VerifyRecipe, poc: Poc): Promise<VerifyResult> {
  const log: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "mb-verify-"));
  const port = recipe.port ?? 4599;
  const base = `http://127.0.0.1:${port}`;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const transcript: VerifyResult["transcript"] = [];
  try {
    // 1. fork: shallow clone the company's repo
    log.push(`git clone --depth 1 ${recipe.ref ? "-b " + recipe.ref + " " : ""}${recipe.repo}`);
    const clone = sh(`git clone --depth 1 ${recipe.ref ? `-b ${recipe.ref} ` : ""}${recipe.repo} app`, dir, 90_000);
    if ((await clone.exited) !== 0) { log.push("clone failed: " + (await new Response(clone.stderr).text()).slice(0, 300)); return fail(); }
    const app = join(dir, "app");

    // 2. build
    if (recipe.buildCmd) {
      log.push(`build: ${recipe.buildCmd}`);
      const b = sh(recipe.buildCmd, app, 180_000);
      const code = await b.exited;
      if (code !== 0) { log.push("build failed: " + (await new Response(b.stderr).text()).slice(0, 300)); return fail(); }
    }

    // 3. run the fork (throwaway deploy)
    if (recipe.runCmd) {
      log.push(`run: PORT=${port} ${recipe.runCmd}`);
      proc = Bun.spawn(["bash", "-lc", recipe.runCmd], { cwd: app, env: { ...process.env, PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
      const ready = await waitPort(base + (recipe.healthPath ?? "/"), Date.now() + (recipe.bootSec ?? 25) * 1000, log);
      if (!ready) return fail();
      log.push("app is up");
    }

    // 4. replay the PoC, collect the transcript
    let combined = "";
    for (const req of poc.requests) {
      const url = req.path.startsWith("http") ? req.path : base + req.path;
      const res = await fetch(url, { method: req.method ?? "GET", headers: req.headers, body: req.body, signal: AbortSignal.timeout(8000) }).catch((e) => ({ status: 0, text: async () => String(e) } as any));
      const body = await res.text();
      combined += `\n### ${req.method ?? "GET"} ${req.path} -> ${res.status}\n${body}`;
      transcript.push({ request: `${req.method ?? "GET"} ${req.path}`, status: res.status, bodySnippet: body.slice(0, 240) });
    }

    // 5. check the committed impact assertion against what actually came back
    let assertionMatched = false;
    try { assertionMatched = new RegExp(poc.assertion, "s").test(combined); }
    catch (e) { log.push("bad assertion regex: " + String(e)); }
    log.push(`assertion /${poc.assertion}/ -> ${assertionMatched ? "MATCH (impact proven)" : "no match"}`);

    const evidenceHash = "0x" + createHash("sha256").update(combined).digest("hex");
    return { proven: assertionMatched, impact: poc.impact, assertionMatched, transcript, evidenceHash, log };
  } catch (e) {
    log.push("verify error: " + (e instanceof Error ? e.message : String(e)));
    return fail();
  } finally {
    if (proc) try { proc.kill(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  function fail(): VerifyResult {
    return { proven: false, impact: poc.impact, assertionMatched: false, transcript, evidenceHash: "0x", log, error: "verification could not complete" };
  }
}
