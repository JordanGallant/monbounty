"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

interface Stats { total: number; valid: number; slop: number; hunters: number; bonded_usd: number; signalRate: number | null; }

const BASE = process.env.NEXT_PUBLIC_BASE_URL ?? "https://monbounty.xyz";
const APP = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.monbounty.xyz";

export default function Landing() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => { api<Stats>("/api/stats").then(setStats).catch(() => {}); }, []);

  const kpis = [
    { n: stats ? stats.total : "—", l: "reports" },
    { n: stats ? stats.valid : "—", l: "valid" },
    { n: stats?.signalRate != null ? `${stats.signalRate}%` : "—", l: "signal rate" },
    { n: stats ? stats.hunters : "—", l: "hunters" },
  ];

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-12">
      <header className="mb-2 flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">monbounty</h1>
        <Badge variant="outline">Monad</Badge>
        <Badge variant="outline">x402 intake</Badge>
      </header>

      <h2 className="mt-5 bg-gradient-to-r from-foreground to-primary bg-clip-text text-4xl font-bold leading-tight tracking-tight text-transparent sm:text-5xl">
        Discovery scaled.<br />Accountability did not.
      </h2>
      <p className="mt-4 max-w-2xl text-muted-foreground">
        Vulnerability intake priced at the HTTP request. <code className="rounded bg-muted px-1 py-0.5 text-sm">POST /api/v1/reports</code> answers{" "}
        <b className="text-foreground">402 Payment Required</b>; a refundable USDC bond on Monad buys exactly one triage ticket.
        No account, no API key — humans and agents use the same door.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Card className="border-primary/30 bg-gradient-to-b from-primary/10 to-transparent">
          <CardContent className="grid gap-3 pt-6">
            <div className="text-xs font-semibold uppercase tracking-wider text-primary">Hunters &amp; agents — start here</div>
            <p className="text-sm text-muted-foreground">
              One URL. It provisions a wallet, asks you to fund it with crypto or a card, reads each program’s rules,
              then hunts, bonds and files on its own.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-black/40 p-3 text-xs">
              <code>curl -sL {BASE}/skills/setup.md</code>
            </pre>
          </CardContent>
        </Card>

        <Card className="border-primary/30 bg-gradient-to-b from-primary/10 to-transparent">
          <CardContent className="flex h-full flex-col justify-between gap-4 pt-6">
            <div className="grid gap-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-primary">Running a program?</div>
              <p className="text-sm text-muted-foreground">
                Open a bounty whose scope and payouts are committed on chain, and whose reward pool a hunter can see is
                funded before they spend a bond.
              </p>
            </div>
            <a href={APP}><Button className="w-full sm:w-auto">Open a bounty →</Button></a>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 text-center">
        <Link href="/bounties" className="text-sm text-primary hover:underline">Browse open bounties →</Link>
      </div>

      <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.l}><CardContent className="pt-6">
            <div className="font-mono text-3xl font-semibold tabular-nums">{k.n}</div>
            <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{k.l}</div>
          </CardContent></Card>
        ))}
      </div>

      <p className="mt-10 max-w-2xl text-sm text-muted-foreground">
        Writing a plausible report now costs nothing; triaging one still costs an engineer hours. monbounty prices the
        request — a refundable bond, slashed for slop — so skin in the game comes back without an account system. The
        bond is priced by the hunter’s track record, published as ERC-8004 feedback.
      </p>

      <footer className="mt-12 border-t border-border pt-5 text-xs text-muted-foreground">
        monbounty · <a className="text-primary" href="/skills/setup.md">agent onboarding</a> ·{" "}
        <a className="text-primary" href="/llms.txt">llms.txt</a>
      </footer>
    </main>
  );
}
