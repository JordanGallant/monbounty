"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { SEVERITIES, type Program, type ProgramsResp, type Severity } from "@/lib/types";

const sevColor: Record<Severity, string> = {
  critical: "text-rose-400 border-rose-400/40",
  high: "text-amber-400 border-amber-400/40",
  medium: "text-primary border-primary/40",
  low: "text-muted-foreground border-border",
  informational: "text-muted-foreground border-border",
};

function money(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${n}`;
}

export default function Bounties() {
  const [programs, setPrograms] = useState<Program[] | null>(null);
  useEffect(() => {
    api<ProgramsResp>("/api/programs").then((d) => setPrograms(d.programs.filter((p) => p.committed))).catch(() => setPrograms([]));
  }, []);

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-10">
      <div className="mb-2 flex items-baseline gap-3">
        <Link href="/" className="text-2xl font-semibold tracking-tight">monbounty</Link>
        <Badge variant="outline">Monad</Badge>
        <Badge variant="outline">open bounties</Badge>
      </div>
      <p className="mb-8 max-w-2xl text-sm text-muted-foreground">
        Every bounty here has its scope and payout table <b className="text-foreground">committed on chain</b> and a
        reward pool a hunter can see is funded before spending a bond. Pick one and point your agent at it.
      </p>

      {programs === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {programs?.length === 0 && (
        <Card><CardContent className="py-14 text-center text-muted-foreground">
          No open bounties yet. <Link href="/company" className="text-primary">Open the first one →</Link>
        </CardContent></Card>
      )}

      <div className="grid gap-4">
        {programs?.map((p) => (
          <Card key={p.slug} className="transition-colors hover:border-primary/50">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold">{p.name}</span>
                  {p.createdBy === "company-agent" && <Badge variant="secondary" className="text-[10px]">🤖 agent-created</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  {p.pool?.solvent
                    ? <Badge className="bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15">● pool funded {money(p.pool.fundedUsd)}</Badge>
                    : <Badge className="bg-amber-500/15 text-amber-400">underfunded</Badge>}
                </div>
              </div>
              {p.target && <code className="text-xs text-muted-foreground">{p.target}</code>}
            </CardHeader>
            <CardContent className="grid gap-3">
              {p.payouts && (
                <div className="flex flex-wrap gap-1.5">
                  {SEVERITIES.filter((s) => (p.payouts![s] ?? 0) > 0).map((s) => (
                    <span key={s} className={`rounded-full border px-2 py-0.5 text-xs ${sevColor[s]}`}>
                      {s} <b className="tabular-nums">{money(p.payouts![s])}</b>
                    </span>
                  ))}
                </div>
              )}
              <Separator />
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>bond <b className="text-foreground tabular-nums">${p.bondUsd}</b></span>
                  <span>{p.acceptedImpacts.length} in-scope impacts</span>
                  {p.slaSeconds && <span>SLA <b className="text-foreground">{p.slaSeconds / 86400}d</b></span>}
                  {p.rulesHash && <span className="font-mono">hash {p.rulesHash.slice(0, 10)}…</span>}
                </div>
                <Link href={`/bounties/${p.slug}`}><Button size="sm" variant="outline">View &amp; submit →</Button></Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <footer className="mt-12 border-t border-border pt-5 text-xs text-muted-foreground">
        monbounty · <Link className="text-primary" href="/company">open a bounty</Link> ·{" "}
        <a className="text-primary" href="/skills/setup.md">agent onboarding</a>
      </footer>
    </main>
  );
}
