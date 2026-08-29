"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { SEVERITIES, type RulesDetail, type Severity } from "@/lib/types";

const sevColor: Record<Severity, string> = {
  critical: "text-rose-400 border-rose-400/40",
  high: "text-amber-400 border-amber-400/40",
  medium: "text-primary border-primary/40",
  low: "text-muted-foreground border-border",
  informational: "text-muted-foreground border-border",
};
const sevDot: Record<Severity, string> = {
  critical: "bg-rose-500", high: "bg-amber-500", medium: "bg-primary", low: "bg-muted-foreground", informational: "bg-muted-foreground",
};
const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${n}`);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default function ProgramPage() {
  const slug = String(useParams().slug ?? "");
  const [d, setD] = useState<RulesDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    api<RulesDetail>(`/api/programs/${slug}/rules`).then(setD).catch((e) => setErr(e.message));
  }, [slug]);

  if (err) return <main className="mx-auto max-w-4xl px-5 py-10"><p className="text-rose-400">Not found: {err}</p><Link className="text-primary" href="/bounties">← all programs</Link></main>;
  if (!d) return <main className="mx-auto max-w-4xl px-5 py-10 text-muted-foreground">Loading…</main>;

  const r = d.rules;
  const isWeb2 = r.acceptedImpacts.some((i) => i.startsWith("web-"));
  const bySev = (s: Severity) => d.impacts.filter((i) => i.severity === s);

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <Link href="/bounties" className="text-xs text-muted-foreground hover:text-foreground">← all programs</Link>

      {/* Header — platform style */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-6 border-b border-border pb-6">
        <div className="max-w-xl">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{r.name}</h1>
            <Badge variant="secondary" className="text-[10px]">{isWeb2 ? "Web / App" : "Smart Contract"}</Badge>
            <Badge variant="outline" className="text-[10px]">Monad</Badge>
          </div>
          {r.target && <code className="mt-1 block text-sm text-muted-foreground">{r.target}</code>}
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className={`rounded-full border px-2 py-0.5 ${d.verified ? "border-emerald-400/40 text-emerald-400" : "border-rose-400/40 text-rose-400"}`}>
              {d.verified ? "✓ rules committed on-chain" : "⚠ hash mismatch"}
            </span>
            <span className={`rounded-full border px-2 py-0.5 ${d.pool.solvent ? "border-emerald-400/40 text-emerald-400" : "border-amber-400/40 text-amber-400"}`}>
              {d.pool.solvent ? `✓ pool funded ${money(d.pool.fundedUsd)}` : "⚠ underfunded"}
            </span>
            {!isWeb2 && <span className="rounded-full border border-primary/40 px-2 py-0.5 text-primary">PoC-provable payouts</span>}
            <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">Response SLA {r.slaSeconds / 86400}d</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Max bounty</div>
          <div className="font-mono text-3xl font-bold tabular-nums text-foreground">{money(r.payouts.critical)}</div>
          <a href="#submit"><Button className="mt-3">Submit a bug →</Button></a>
        </div>
      </div>

      <div className="mt-6 grid gap-4">
        {/* Rewards by severity — table */}
        <Section title="Rewards by threat level">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">Severity</th>
                  <th className="pb-2 font-medium">Reward (USD)</th>
                  <th className="pb-2 font-medium">In-scope impacts</th>
                </tr>
              </thead>
              <tbody>
                {SEVERITIES.filter((s) => s !== "informational").map((s) => (
                  <tr key={s} className="border-t border-border">
                    <td className="py-2.5"><span className="inline-flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${sevDot[s]}`} /><span className="capitalize">{s}</span></span></td>
                    <td className="py-2.5 font-mono tabular-nums">{r.payouts[s] > 0 ? `$${r.payouts[s].toLocaleString()}` : "—"}</td>
                    <td className="py-2.5 text-muted-foreground">{bySev(s).length || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Submission price (refundable bond): <b className="text-foreground">${r.bondUsd}</b>, slashed only for slop. Payout committed on-chain; a valid finding is paid and the bond refunded in one transaction.</p>
        </Section>

        {/* Assets in scope */}
        <Section title={`Assets in scope (${r.scopeIn.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground"><th className="pb-2 font-medium">Target</th><th className="pb-2 font-medium">Type</th></tr></thead>
              <tbody>
                {r.scopeIn.map((a) => (
                  <tr key={a} className="border-t border-border">
                    <td className="py-2.5 font-mono text-[13px]">{a}</td>
                    <td className="py-2.5 text-muted-foreground">{isWeb2 ? "Website / API" : "Smart contract"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Impacts in scope */}
        <Section title="Impacts in scope">
          <div className="grid gap-2">
            {d.impacts.map((im) => (
              <div key={im.id} className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm">
                <div className="grid gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {im.label ?? im.id}
                    {im.severity && <span className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase ${sevColor[im.severity]}`}>{im.severity}</span>}
                    {im.machineCheckable && <span className="rounded-full border border-emerald-400/50 px-1.5 py-0.5 text-[10px] text-emerald-400">PoC-provable</span>}
                  </div>
                  <code className="text-[11px] text-muted-foreground">{im.id}</code>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Out of scope / rules */}
        <Section title="Out of scope & rules">
          <ul className="grid gap-1 text-sm">{r.scopeOut.map((x) => <li key={x} className="text-muted-foreground">• {x}</li>)}</ul>
        </Section>

        {/* Trust panel */}
        <Section title="On-chain commitment">
          <div className="grid gap-1.5 text-xs">
            <div className="flex flex-wrap gap-2"><span className="min-w-28 text-muted-foreground">rulesHash</span><span className="break-all font-mono text-foreground">{d.rulesHash}</span></div>
            <div className="flex flex-wrap gap-2"><span className="min-w-28 text-muted-foreground">verification</span><span className={d.verified ? "text-emerald-400" : "text-rose-400"}>{d.verified ? "served rules match the committed hash" : "mismatch"}</span></div>
            <div className="flex flex-wrap gap-2"><span className="min-w-28 text-muted-foreground">reward pool</span><span className="text-foreground">${d.pool.fundedUsd.toLocaleString()} funded / ${d.pool.committedUsd.toLocaleString()} committed</span></div>
          </div>
        </Section>

        {/* Submit */}
        <Card id="submit" className="border-primary/30">
          <CardHeader className="pb-3"><CardTitle className="text-xs font-semibold uppercase tracking-wider text-primary">Submit a finding</CardTitle></CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p className="text-muted-foreground">No account. Point your agent at the onboarding skill — it provisions a wallet, reads these rules, then bonds and files. Nothing is queued until the PoC gate is paid.</p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-black/40 p-3 text-xs"><code>curl -sL https://monbounty.xyz/skills/setup.md</code></pre>
            <p className="text-xs text-muted-foreground">Program slug: <code className="text-foreground">{d.slug}</code></p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
