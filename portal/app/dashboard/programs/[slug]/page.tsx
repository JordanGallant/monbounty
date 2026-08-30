"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { SEVERITIES, type RulesDetail, type ProgramReports, type Severity } from "@/lib/types";

const sevColor: Record<Severity, string> = {
  critical: "text-rose-400 border-rose-400/40", high: "text-amber-400 border-amber-400/40",
  medium: "text-primary border-primary/40", low: "text-muted-foreground border-border", informational: "text-muted-foreground border-border",
};
const statusColor: Record<string, string> = {
  valid: "text-emerald-400", slop: "text-rose-400", duplicate: "text-amber-400",
  out_of_scope: "text-amber-400", triaging: "text-primary", awaiting_poc: "text-muted-foreground",
};
const riskBadge: Record<string, string> = {
  allow: "bg-emerald-500/15 text-emerald-400", risk: "bg-amber-500/15 text-amber-400", deny: "bg-rose-500/15 text-rose-400",
};
const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${n}`);
const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso.replace(" ", "T") + (iso.includes("+") ? "" : "Z")).getTime()) / 1000); return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : `${(s / 3600) | 0}h`; };

export default function CompanyProgram() {
  const slug = String(useParams().slug ?? "");
  const [rules, setRules] = useState<RulesDetail | null>(null);
  const [feed, setFeed] = useState<ProgramReports | null>(null);
  const [live, setLive] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(() => { if (slug) api<ProgramReports>(`/api/programs/${slug}/reports`).then(setFeed).catch(() => {}); }, [slug]);

  useEffect(() => {
    if (!slug) return;
    api<RulesDetail>(`/api/programs/${slug}/rules`).then(setRules).catch(() => {});
    poll();
    timer.current = setInterval(poll, 5000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [slug, poll]);

  const r = rules?.rules;
  const isWeb2 = r?.acceptedImpacts.some((i) => i.startsWith("web-"));

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">← monbounty · programs</Link>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-emerald-500" : "bg-muted-foreground"}`} />
            {live ? "live" : "paused"}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8">
        {/* header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{r?.name ?? slug}</h1>
              <Badge variant="secondary" className="text-[10px]">{isWeb2 ? "Web / App" : "Smart Contract"}</Badge>
              {rules && <Badge className={rules.pool.solvent ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15" : "bg-amber-500/15 text-amber-400"}>{rules.pool.solvent ? "● live" : "underfunded"}</Badge>}
            </div>
            {r?.target && <code className="text-sm text-muted-foreground">{r.target}</code>}
          </div>
          <div className="flex gap-2">
            <Link href={`/bounties/${slug}`}><Button variant="outline" size="sm">Public page ↗</Button></Link>
          </div>
        </div>

        {/* stat strip */}
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { l: "Submissions", n: feed ? feed.total : "—" },
            { l: "Valid", n: feed ? (feed.counts.valid ?? 0) : "—" },
            { l: "Awaiting triage", n: feed ? ((feed.counts.triaging ?? 0) + (feed.counts.awaiting_poc ?? 0)) : "—" },
            { l: "Max bounty", n: r ? money(r.payouts.critical) : "—" },
          ].map((k) => (
            <Card key={k.l}><CardContent className="pt-6"><div className="font-mono text-2xl font-semibold tabular-nums">{k.n}</div><div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{k.l}</div></CardContent></Card>
          ))}
        </div>

        {/* Verification target */}
        <RecipePanel slug={slug} />

        {/* SUBMISSIONS — real time */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Current submissions</CardTitle>
            <button onClick={() => { setLive((v) => { const nv = !v; if (nv) { poll(); timer.current = setInterval(poll, 5000); } else if (timer.current) clearInterval(timer.current); return nv; }); }} className="text-xs text-muted-foreground hover:text-foreground">
              {live ? "pause" : "resume"}
            </button>
          </CardHeader>
          <CardContent>
            {!feed && <p className="text-sm text-muted-foreground">Loading…</p>}
            {feed?.total === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No submissions yet.</p>}
            {feed && feed.total > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">Finding</th><th className="pb-2 font-medium">Severity</th>
                    <th className="pb-2 font-medium">Status</th><th className="pb-2 font-medium">Submitter</th>
                    <th className="pb-2 font-medium">Risk</th><th className="pb-2 font-medium">Age</th>
                  </tr></thead>
                  <tbody>
                    {feed.reports.map((s) => (
                      <FragmentRow key={s.id} s={s} isOpen={open.has(s.id)} onToggle={() => toggle(s.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">Submitters are risk-scored from their on-chain track record: <span className="text-emerald-400">allow</span> (proven/trusted), <span className="text-amber-400">risk</span> (new — premium bond, watched), <span className="text-rose-400">DENY</span> (penalised — bond refused at intake).</p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function RecipePanel({ slug }: { slug: string }) {
  const [mode, setMode] = useState<"onchain-fork" | "company-attested">("onchain-fork");
  const [repo, setRepo] = useState("");
  const [runCmd, setRunCmd] = useState("bun run server.js");
  const [buildCmd, setBuildCmd] = useState("");
  const [assertJson, setAssertJson] = useState('{"web-idor":"sk_live_.*LEAKED"}');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/company-api/recipe?slug=${slug}`).then((r) => r.json()).then((d) => {
      if (d.verificationMode) setMode(d.verificationMode);
      const rc = d.recipe;
      if (rc) { setRepo(rc.repo ?? ""); setRunCmd(rc.runCmd ?? "bun run server.js"); setBuildCmd(rc.buildCmd ?? "");
        if (rc.assertions) setAssertJson(JSON.stringify(rc.assertions)); }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [slug]);

  async function save() {
    setSaving(true);
    let assertions: any = {};
    try { assertions = JSON.parse(assertJson || "{}"); } catch { setSaving(false); return toast.error("Assertions must be valid JSON."); }
    const body: any = { slug, verificationMode: mode };
    if (mode === "company-attested") Object.assign(body, { repo: repo.trim(), runCmd: runCmd.trim(), buildCmd: buildCmd.trim() || undefined, port: 4700, healthPath: "/", assertions });
    const res = await fetch("/company-api/recipe", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setSaving(false);
    if (!res.ok) { const e = await res.json().catch(() => ({})); return toast.error(e.error ?? "save failed"); }
    toast.success("Verification target saved."); setEditing(false);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Verification target</CardTitle>
        {!editing && loaded && <button onClick={() => setEditing(true)} className="text-xs text-primary hover:underline">edit</button>}
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {!editing ? (
          <div className="grid gap-1 text-xs">
            <div className="flex gap-2"><span className="min-w-24 text-muted-foreground">mode</span><span>{mode}</span></div>
            {mode === "company-attested" ? (
              <>
                <div className="flex gap-2"><span className="min-w-24 text-muted-foreground">repo</span><span className="break-all font-mono text-foreground">{repo || "— not set —"}</span></div>
                <div className="flex gap-2"><span className="min-w-24 text-muted-foreground">run</span><code className="text-foreground">{runCmd}</code></div>
                <p className="mt-1 text-muted-foreground">On a submission we clone this repo in a sandbox, run it, replay the PoC, and check the impact assertion. Your code never leaves the sandbox.</p>
              </>
            ) : <p className="text-muted-foreground">Smart-contract bounty — PoC executed against a chain fork; no repo needed.</p>}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode((v as any) ?? "onchain-fork")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="onchain-fork">On-chain fork (smart contracts)</SelectItem>
                  <SelectItem value="company-attested">Company-attested (fork repo, run PoC)</SelectItem>
                </SelectContent>
              </Select></div>
            {mode === "company-attested" && (
              <>
                <div className="grid gap-1.5"><Label>Repo URL</Label><Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/you/target" /></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5"><Label>Build cmd (optional)</Label><Input value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} placeholder="bun install" /></div>
                  <div className="grid gap-1.5"><Label>Run cmd</Label><Input value={runCmd} onChange={(e) => setRunCmd(e.target.value)} /></div>
                </div>
                <div className="grid gap-1.5"><Label>Impact assertions (JSON: impactId → regex)</Label><Input className="font-mono text-xs" value={assertJson} onChange={(e) => setAssertJson(e.target.value)} /></div>
              </>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FragmentRow({ s, isOpen, onToggle }: { s: import("@/lib/types").SubmissionRow; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-t border-border align-top hover:bg-muted/30">
        <td className="py-2.5 pr-3 max-w-xs">
          <span className="mr-1.5 inline-block w-3 text-muted-foreground">{isOpen ? "▾" : "▸"}</span>
          {s.title}{s.hasPoc && <span className="ml-2 text-[10px] text-emerald-400">PoC</span>}
        </td>
        <td className="py-2.5"><span className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase ${sevColor[s.severity]}`}>{s.severity}</span></td>
        <td className={`py-2.5 ${statusColor[s.status] ?? ""}`}>{s.status.replace(/_/g, " ")}{s.payoutUsd ? <span className="text-emerald-400"> · {money(s.payoutUsd)}</span> : ""}</td>
        <td className="py-2.5 font-mono text-xs text-muted-foreground">{s.hunter.slice(0, 8)}…{s.risk.agentId && <span className="ml-1 text-primary">#8004:{s.risk.agentId}</span>}</td>
        <td className="py-2.5"><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${riskBadge[s.risk.decision]}`}>{s.risk.decision === "deny" ? "DENY" : s.risk.decision}</span> <span className="text-[10px] text-muted-foreground">{s.risk.tier}</span></td>
        <td className="py-2.5 text-xs text-muted-foreground">{ago(s.createdAt)}</td>
      </tr>
      {isOpen && (
        <tr className="border-0"><td colSpan={6} className="pb-3">
          <div className="grid gap-3">
            <FindingDoc s={s} />
            <Terminal id={s.id} lines={s.trace} />
          </div>
        </td></tr>
      )}
    </>
  );
}

function FindingDoc({ s }: { s: import("@/lib/types").SubmissionRow }) {
  const poc = typeof s.poc === "object" ? s.poc : null;
  const reqs = poc?.requests ?? [];
  const riskColor = s.risk.decision === "deny" ? "text-rose-400" : s.risk.decision === "risk" ? "text-amber-400" : "text-emerald-400";
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4 text-sm">
      {/* README-style finding doc */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <span className="text-base font-semibold">{s.title}</span>
        <span className="rounded-full border border-primary/40 px-2 py-0.5 text-[10px] uppercase text-primary">{s.severity}</span>
        {poc?.impact && <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{poc.impact}</code>}
      </div>

      <div className="mt-3 grid gap-3">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Submitted by (attacker)</div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span className="text-foreground">{s.hunter}</span>
            <span className={`rounded-full bg-muted px-2 py-0.5 text-[10px] ${riskColor}`}>{s.risk.tier} · {s.risk.decision}</span>
            {s.risk.agentId && <span className="text-primary">ERC-8004 #{s.risk.agentId}</span>}
          </div>
        </div>

        {s.summary && (
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Summary</div>
            <p className="leading-relaxed text-muted-foreground">{s.summary}</p>
          </div>
        )}

        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Proof of concept{s.asset ? ` · ${s.asset}` : ""}</div>
          {reqs.length > 0 ? (
            <pre className="overflow-x-auto rounded-lg border border-border bg-black/40 p-3 text-xs leading-relaxed">
              <code>{reqs.map((r, i) => `${i + 1}. ${r.method ?? "GET"} ${r.path}${r.body ? "\n   body: " + r.body : ""}`).join("\n")}</code>
            </pre>
          ) : (
            <pre className="overflow-x-auto rounded-lg border border-border bg-black/40 p-3 text-xs"><code>{typeof s.poc === "string" ? s.poc : "—"}</code></pre>
          )}
        </div>

        {s.contentHash && (
          <div className="font-mono text-[11px] text-muted-foreground">content hash: {s.contentHash.slice(0, 22)}…</div>
        )}
      </div>
    </div>
  );
}

const lvlColor: Record<string, string> = {
  in: "text-sky-400", info: "text-zinc-300", ok: "text-emerald-400",
  warn: "text-amber-400", deny: "text-rose-400", run: "text-violet-400",
};
function Terminal({ id, lines }: { id: string; lines: { level: string; text: string; tx?: string; url?: string }[] }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    setShown(0);
    const timers = lines.map((_, i) => setTimeout(() => setShown((n) => Math.max(n, i + 1)), 140 * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [id, lines.length]);
  const done = shown >= lines.length;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-[#0a0a0c] font-mono text-[12px] leading-relaxed">
      <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" /><span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        <span className="ml-2 text-[11px] text-zinc-500">triager · {id.slice(0, 8)}</span>
      </div>
      <div className="px-3 py-2.5">
        {lines.slice(0, shown).map((l, i) => (
          <div key={i} className="flex flex-wrap gap-2">
            <span className="select-none text-zinc-600">{String(i + 1).padStart(2, "0")}</span>
            <span className="select-none text-zinc-600">$</span>
            <span className={lvlColor[l.level] ?? "text-zinc-300"}>{l.text}</span>
            {l.url && (
              <a href={l.url} target="_blank" rel="noreferrer"
                 className="text-sky-400 underline decoration-dotted underline-offset-2 hover:text-sky-300">
                {l.tx ? `${l.tx.slice(0, 10)}…↗` : "tx ↗"}
              </a>
            )}
          </div>
        ))}
        {!done && <div className="flex gap-2"><span className="text-zinc-600">··</span><span className="animate-pulse text-violet-400">▊</span></div>}
        {done && <div className="flex gap-2"><span className="select-none text-zinc-600">$</span><span className="animate-pulse text-zinc-500">▊</span></div>}
      </div>
    </div>
  );
}
