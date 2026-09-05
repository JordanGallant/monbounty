// Deployment context: exploitability is a property of code × deployment, not
// code alone. The same source can carry a "real" CVE that is dead in production
// because the exploited surface does not exist on the platform it runs on — the
// canonical example being Next.js middleware auth bypass (CVE-2025-29927), which
// reproduces under a raw `next start` but is neutralised on Vercel because the
// edge handles the request the exploit forges.
//
// So onboarding must capture WHERE the target runs, and verification must name
// WHICH surface it proved against. This module holds:
//   1. the platform vocabulary,
//   2. a curated "commonly neutralised on this platform" matrix, and
//   3. helpers the company onboarding agent uses to pre-seed scopeOut and shape
//      the verification recipe.
//
// IMPORTANT: the matrix is a STARTING POINT the company confirms, never an
// oracle. Each entry produces a suggested, human-readable scopeOut line — which
// is hash-committed and shown to hunters before they bond — not an automatic
// rejection. "Commonly neutralised" is hedged on purpose; the company owns the
// final call on its own deployment.

export type PlatformId =
  | "vercel"
  | "netlify"
  | "cloudflare-workers"
  | "aws-lambda"
  | "node"          // self-hosted long-lived process (next start, node server.js, pm2, …)
  | "docker"        // self-hosted container
  | "kubernetes"
  | "unknown";

export interface PlatformInfo {
  id: PlatformId;
  label: string;
  /** Broad shape of the runtime, so verdicts and scope can reason about it. */
  traits: {
    serverless: boolean;       // per-request, no long-lived process
    readOnlyFs: boolean;       // only /tmp writable
    managedEdge: boolean;      // platform terminates/normalises requests at an edge
    persistentProcess: boolean;// background timers, in-memory state, websockets survive
  };
  /** Can our sandbox stand this platform up FAITHFULLY today? A raw runCmd only
   *  represents self-hosted long-lived processes; managed platforms need their
   *  own harness (vercel dev / workerd), which is a follow-up. */
  reproducible: boolean;
}

export const PLATFORMS: Record<PlatformId, PlatformInfo> = {
  vercel: {
    id: "vercel", label: "Vercel",
    traits: { serverless: true, readOnlyFs: true, managedEdge: true, persistentProcess: false },
    reproducible: false,
  },
  netlify: {
    id: "netlify", label: "Netlify",
    traits: { serverless: true, readOnlyFs: true, managedEdge: true, persistentProcess: false },
    reproducible: false,
  },
  "cloudflare-workers": {
    id: "cloudflare-workers", label: "Cloudflare Workers",
    traits: { serverless: true, readOnlyFs: true, managedEdge: true, persistentProcess: false },
    reproducible: false,
  },
  "aws-lambda": {
    id: "aws-lambda", label: "AWS Lambda",
    traits: { serverless: true, readOnlyFs: true, managedEdge: false, persistentProcess: false },
    reproducible: false,
  },
  node: {
    id: "node", label: "Self-hosted Node (long-lived process)",
    traits: { serverless: false, readOnlyFs: false, managedEdge: false, persistentProcess: true },
    reproducible: true,
  },
  docker: {
    id: "docker", label: "Self-hosted container",
    traits: { serverless: false, readOnlyFs: false, managedEdge: false, persistentProcess: true },
    reproducible: true,
  },
  kubernetes: {
    id: "kubernetes", label: "Kubernetes",
    traits: { serverless: false, readOnlyFs: false, managedEdge: false, persistentProcess: true },
    reproducible: true,
  },
  unknown: {
    id: "unknown", label: "Unspecified",
    traits: { serverless: false, readOnlyFs: false, managedEdge: false, persistentProcess: false },
    reproducible: false,
  },
};

export function normalizePlatform(v: string | null | undefined): PlatformId {
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (s in PLATFORMS) return s as PlatformId;
  // common aliases
  if (["cf", "workers", "cloudflare"].includes(s)) return "cloudflare-workers";
  if (["lambda", "aws", "serverless-framework"].includes(s)) return "aws-lambda";
  if (["self-hosted", "vps", "bare-metal", "ec2", "pm2", "nodejs"].includes(s)) return "node";
  if (["container", "compose"].includes(s)) return "docker";
  if (["k8s", "eks", "gke"].includes(s)) return "kubernetes";
  return s ? "unknown" : "unknown";
}

/** The deployment profile a company commits alongside its verification recipe. */
export interface DeploymentProfile {
  platform: PlatformId;
  framework?: string;        // "nextjs" | "express" | "django" | …
  frameworkVersion?: string; // free text, e.g. "15.2.0"
  runtime?: string;          // "nodejs20.x"
  waf?: boolean;             // a WAF sits in front in production
  notes?: string;            // anything the sandbox run can't capture
}

// ── the neutralised-here matrix ──────────────────────────────────────────────
//
// Each entry says: "on THESE platforms, THIS class of finding is commonly not
// exploitable, for THIS reason." Framework-scoped when it only applies to one
// stack (`framework`), otherwise platform-general.

export interface NeutralizedRule {
  id: string;                 // stable key, e.g. "nextjs-cve-2025-29927"
  title: string;
  framework?: string;         // omit = framework-agnostic
  platforms: PlatformId[];    // platforms on which this is commonly neutralised
  /** Or match by platform trait instead of an explicit list (either can hit). */
  whenTrait?: keyof PlatformInfo["traits"];
  reason: string;             // why it's neutralised there (goes into the scopeOut line)
  reference?: string;         // CVE / advisory id for the company to check against
}

export const NEUTRALIZED_RULES: NeutralizedRule[] = [
  {
    id: "nextjs-cve-2025-29927",
    title: "Next.js middleware authorization bypass",
    framework: "nextjs",
    platforms: ["vercel"],
    reason:
      "The exploit forges the internal x-middleware-subrequest header to skip middleware " +
      "(auth) checks. On Vercel, middleware runs on the platform's managed edge, which does " +
      "not honour an externally-supplied value for that header, so the bypass does not " +
      "reproduce. Self-hosted `next start` behind your own proxy IS affected — confirm your host.",
    reference: "CVE-2025-29927",
  },
  {
    id: "readonly-fs-write-rce",
    title: "RCE / persistence via writing to the application filesystem",
    whenTrait: "readOnlyFs",
    platforms: [],
    reason:
      "The application filesystem is read-only on this platform (only /tmp is writable, and it " +
      "does not persist across invocations), so exploits that depend on writing a webshell, " +
      "poisoning a cache file on disk, or otherwise persisting to the app dir do not reproduce.",
  },
  {
    id: "serverless-no-persistent-process",
    title: "Exploits requiring a long-lived process (background timers, in-memory state, websockets)",
    whenTrait: "serverless",
    platforms: [],
    reason:
      "Each request runs in a fresh, ephemeral invocation with no shared in-memory state and no " +
      "background timers surviving between requests, so findings that depend on a persistent " +
      "process (timing side-channels across requests, in-memory session poisoning, long-lived " +
      "websocket state) do not reproduce as they would on a self-hosted long-lived server.",
  },
  {
    id: "managed-edge-request-smuggling",
    title: "Request smuggling / malformed-request handling at the origin",
    whenTrait: "managedEdge",
    platforms: [],
    reason:
      "Requests are terminated and normalised at the platform's managed edge before reaching " +
      "application code, so classic HTTP request-smuggling and raw malformed-request handling " +
      "against the origin are generally not reachable. Confirm whether your edge config forwards " +
      "the specific vector.",
  },
];

export interface NeutralizedHit {
  id: string;
  title: string;
  reference?: string;
  reason: string;
  /** Ready-to-commit scopeOut line the company can accept as-is or edit. */
  scopeOutLine: string;
  confidence: "commonly-neutralised";
}

/**
 * Given a deployment profile, return the classes commonly neutralised there —
 * as suggested scopeOut lines the onboarding agent shows the company. Matches
 * on explicit platform list OR on a platform trait, and on framework when the
 * rule is framework-scoped.
 */
export function neutralizedFor(profile: Pick<DeploymentProfile, "platform" | "framework">): NeutralizedHit[] {
  const plat = PLATFORMS[profile.platform] ?? PLATFORMS.unknown;
  const fw = (profile.framework ?? "").trim().toLowerCase();
  const hits: NeutralizedHit[] = [];
  for (const rule of NEUTRALIZED_RULES) {
    if (rule.framework && rule.framework.toLowerCase() !== fw) continue;
    const byList = rule.platforms.includes(profile.platform);
    const byTrait = rule.whenTrait ? plat.traits[rule.whenTrait] === true : false;
    if (!byList && !byTrait) continue;
    const tag = rule.reference ? `${rule.reference} (${rule.title})` : rule.title;
    hits.push({
      id: rule.id,
      title: rule.title,
      reference: rule.reference,
      reason: rule.reason,
      scopeOutLine: `Out of scope on ${plat.label}: ${tag} — ${rule.reason}`,
      confidence: "commonly-neutralised",
    });
  }
  return hits;
}

/**
 * A short human label for what a sandbox run actually proved against, and
 * whether that surface faithfully represents the declared platform. Used to
 * qualify every verdict so a sandbox "proven" is never silently read as
 * "exploitable in production" on a platform we didn't reproduce.
 */
export function describeSurface(profile?: DeploymentProfile | null): { surface: string; representative: boolean } {
  if (!profile || !profile.platform || profile.platform === "unknown") {
    return { surface: "reference runtime (self-hosted long-lived process)", representative: true };
  }
  const plat = PLATFORMS[profile.platform] ?? PLATFORMS.unknown;
  if (plat.reproducible) {
    return { surface: `${plat.label} (reproduced)`, representative: true };
  }
  return {
    surface: `reference runtime — ${plat.label} not reproduced`,
    representative: false,
  };
}
