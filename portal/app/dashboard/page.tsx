"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import type { Program, ProgramsResp } from "@/lib/types";
import BalanceCard from "./BalanceCard";

const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${n}`);
const isWeb2 = (p: Program) => p.acceptedImpacts.some((i) => i.startsWith("web-"));

export default function Dashboard() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [programs, setPrograms] = useState<Program[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    api<ProgramsResp>("/api/programs").then((d) => setPrograms(d.programs.filter((p) => p.committed))).catch(() => setPrograms([]));
  }, []);

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login"); router.refresh();
  }

  const totalPool = (programs ?? []).reduce((s, p) => s + (p.pool?.fundedUsd ?? 0), 0);
  const maxBounty = Math.max(0, ...(programs ?? []).map((p) => p.payouts?.critical ?? 0));

  return (
    <div className="min-h-screen">
      {/* top bar */}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tracking-tight">monbounty</span>
            <Badge variant="outline" className="text-[10px]">company</Badge>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {email && <span className="text-muted-foreground">{email}</span>}
            <Button variant="outline" size="sm" onClick={signOut}>Sign out</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8">
        {/* org header, Immunefi-style */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Your programs</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Bounties you run on monbounty. Scope and payouts are committed on chain; pools are provably funded.
            </p>
          </div>
          <Link href="/company"><Button>+ New program</Button></Link>
        </div>

        {/* unified balance: top up by card or crypto, fund pools, withdraw */}
        <BalanceCard />

        {/* org stat strip */}
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { l: "Programs", n: programs ? programs.length : "—" },
            { l: "Max bounty", n: programs ? money(maxBounty) : "—" },
            { l: "Total pool funded", n: programs ? money(totalPool) : "—" },
            { l: "Chain", n: "Monad" },
          ].map((k) => (
            <Card key={k.l}><CardContent className="pt-6">
              <div className="font-mono text-2xl font-semibold tabular-nums">{k.n}</div>
              <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{k.l}</div>
            </CardContent></Card>
          ))}
        </div>

        {/* program list */}
        {programs === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {programs?.length === 0 && (
          <Card><CardContent className="py-12 text-center text-muted-foreground">
            No programs yet. <Link href="/company" className="text-primary">Create your first →</Link>
          </CardContent></Card>
        )}
        <div className="grid gap-4">
          {programs?.map((p) => (
            <Card key={p.slug} className="transition-colors hover:border-primary/50">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold">{p.name}</span>
                    <Badge variant="secondary" className="text-[10px]">{isWeb2(p) ? "Web / App" : "Smart Contract"}</Badge>
                  </div>
                  <Badge className={p.pool?.solvent ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15" : "bg-amber-500/15 text-amber-400"}>
                    {p.pool?.solvent ? "● live" : "underfunded"}
                  </Badge>
                </div>
                {p.target && <code className="text-xs text-muted-foreground">{p.target}</code>}
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  <span className="text-muted-foreground">max bounty <b className="text-foreground tabular-nums">{money(p.payouts?.critical ?? 0)}</b></span>
                  <span className="text-muted-foreground">pool <b className="text-foreground tabular-nums">{money(p.pool?.fundedUsd ?? 0)}</b></span>
                  <span className="text-muted-foreground">{p.acceptedImpacts.length} impacts</span>
                  <span className="text-muted-foreground">submission price <b className="text-foreground">${p.bondUsd}</b></span>
                </div>
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="rounded-full border border-emerald-400/40 px-2 py-0.5 text-emerald-400">✓ rules committed on-chain</span>
                    <span className="rounded-full border border-emerald-400/40 px-2 py-0.5 text-emerald-400">✓ pool funded</span>
                    {p.acceptedImpacts.some((i) => !i.startsWith("web-")) &&
                      <span className="rounded-full border border-primary/40 px-2 py-0.5 text-primary">PoC-provable</span>}
                  </div>
                  <Link href={`/dashboard/programs/${p.slug}`}><Button size="sm" variant="outline">View program →</Button></Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    </div>
  );
}
