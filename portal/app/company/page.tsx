"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import {
  SEVERITIES, type Severity, type Payouts, type SeverityInfo,
  type CreatedBounty, type RulesView,
} from "@/lib/types";

const sevColor: Record<Severity, string> = {
  critical: "text-rose-400 border-rose-400/40",
  high: "text-amber-400 border-amber-400/40",
  medium: "text-primary border-primary/40",
  low: "text-muted-foreground border-border",
  informational: "text-muted-foreground border-border",
};

const ONCHAIN: Payouts = { critical: 50000, high: 10000, medium: 5000, low: 1000, informational: 0 };
const WEB2: Payouts = { critical: 5000, high: 1500, medium: 500, low: 150, informational: 0 };

function StepHead({ n, title, done }: { n: number; title: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
          done ? "bg-emerald-500 text-black" : "bg-primary text-primary-foreground"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <CardTitle className="text-sm font-semibold uppercase tracking-wide text-primary">
        {title}
      </CardTitle>
    </div>
  );
}

export default function CompanyPortal() {
  const [info, setInfo] = useState<SeverityInfo | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [scopeIn, setScopeIn] = useState("");
  const [scopeOut, setScopeOut] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [payouts, setPayouts] = useState<Payouts>(ONCHAIN);
  const [tvl, setTvl] = useState("");
  const [bond, setBond] = useState("1");
  const [sla, setSla] = useState("604800");
  const [ruler, setRuler] = useState("");
  const [vmode, setVmode] = useState<"onchain-fork" | "company-attested">("onchain-fork");
  const [repo, setRepo] = useState("");
  const [runCmd, setRunCmd] = useState("bun run demo-target/server.js");
  const [buildCmd, setBuildCmd] = useState("");
  const [assertions, setAssertions] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<CreatedBounty | null>(null);
  const [fundAmt, setFundAmt] = useState("");
  const [verify, setVerify] = useState<RulesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    api<SeverityInfo>("/api/severity")
      .then((d) => { setInfo(d); if (d.presets?.onchain) setPayouts(d.presets.onchain); })
      .catch((e) => toast.error(`Could not load impact catalogue: ${e.message}`));
  }, []);

  const payMsg = useMemo(() => {
    for (let i = 1; i < SEVERITIES.length; i++) {
      const hi = SEVERITIES[i - 1], lo = SEVERITIES[i];
      if (payouts[lo] > payouts[hi])
        return { ok: false, msg: `${lo} ($${payouts[lo].toLocaleString()}) pays more than ${hi} — must be monotonic.` };
    }
    if (payouts.critical <= 0) return { ok: false, msg: "critical must be > $0 (it is the reward pool you fund)." };
    return { ok: true, msg: `Monotonic · reward pool to fund = $${payouts.critical.toLocaleString()}` };
  }, [payouts]);

  const toggle = (id: string) =>
    setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const setPay = (s: Severity, v: string) => setPayouts((p) => ({ ...p, [s]: Number(v || 0) }));
  const sizeCritical = (v: string) => {
    setTvl(v);
    const t = Number(v || 0);
    if (t) setPayouts((p) => ({ ...p, critical: Math.min(1_000_000, Math.max(50_000, Math.round(t * 0.1))) }));
  };

  async function create() {
    if (picked.size === 0) return toast.error("Pick at least one impact in step 2.");
    if (!payMsg.ok) return toast.error(payMsg.msg);
    setBusy(true);
    try {
      const body = {
        slug: slug.trim(), name: name.trim(), target: target.trim(),
        scopeIn: scopeIn.split("\n").map((s) => s.trim()).filter(Boolean),
        scopeOut: scopeOut.split("\n").map((s) => s.trim()).filter(Boolean),
        acceptedImpacts: [...picked], payouts, bondUsd: Number(bond || 1),
        slaSeconds: Number(sla), ruler: ruler.trim(), createdBy: email ?? "company-portal",
        verificationMode: vmode,
        verifyRecipe: vmode === "company-attested"
          ? { repo: repo.trim(), buildCmd: buildCmd.trim() || undefined, runCmd: runCmd.trim() || undefined,
              port: 4700, healthPath: "/", assertions }
          : undefined,
      };
      if (vmode === "company-attested" && !repo.trim()) { setBusy(false); return toast.error("Company-attested needs a repo URL."); }
      const d = await api<CreatedBounty>("/api/programs", { method: "POST", body: JSON.stringify(body) });
      setCreated(d); setFundAmt(String(d.rewardPoolUsd));
      toast.success("Submitted for review — rules committed on chain. It lists to hunters once monbounty approves it.");
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  async function fund(confirmed: boolean) {
    if (!created) return;
    try {
      const d = await api(`/api/programs/${created.slug}/fund`, {
        method: "POST", body: JSON.stringify({ amountUsd: Number(fundAmt || 0), confirmed }),
      });
      if (confirmed) {
        const v = await api<RulesView>(`/api/programs/${created.slug}/rules`);
        setVerify(v);
        toast.success(v.pool.solvent ? "Funded — pool is solvent." : "Recorded, still underfunded.");
      } else {
        toast.info(d.paths?.crypto?.instruction ?? "Send USDC to the ruler address.");
      }
    } catch (e: any) { toast.error(e.message); }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <div className="mb-2 flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">monbounty</h1>
        <Badge variant="outline">Monad</Badge>
        <Badge variant="outline">open a bounty</Badge>
        <Link href="/bounties" className="ml-auto text-sm text-primary hover:underline">Open bounties →</Link>
      </div>
      <p className="mb-8 max-w-2xl text-sm text-muted-foreground">
        Turn a target into a bounty a hunter can <b className="text-foreground">trust</b>. Your scope and payout
        table are hashed on chain when you create it, so they cannot move after a report lands. You set the prices;
        the severity band is fixed by the impact. Fund the pool and hunters see it is solvent before they spend a bond.
      </p>

      <div className="flex flex-col gap-4">
        {/* Step 1 */}
        <Card>
          <CardHeader><StepHead n={1} title="Target & scope" /></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5"><Label>Program slug</Label>
                <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-protocol" maxLength={40} /></div>
              <div className="grid gap-1.5"><Label>Display name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Protocol" /></div>
            </div>
            <div className="grid gap-1.5"><Label>Target (contract path, address or URL)</Label>
              <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="contracts/Vault.sol" /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5"><Label>In scope (one per line)</Label>
                <Textarea value={scopeIn} onChange={(e) => setScopeIn(e.target.value)} placeholder={"direct theft of vault funds\nreentrancy\naccess control"} /></div>
              <div className="grid gap-1.5"><Label>Out of scope (one per line)</Label>
                <Textarea value={scopeOut} onChange={(e) => setScopeOut(e.target.value)} placeholder={"gas optimisation\nadmin-key centralisation"} /></div>
            </div>
          </CardContent>
        </Card>

        {/* Step 2 */}
        <Card>
          <CardHeader><StepHead n={2} title="What you'll pay for — pick the impacts" /></CardHeader>
          <CardContent className="grid gap-2">
            <p className="text-xs text-muted-foreground">
              Severity is not a number you choose; it follows from what a finding does.{" "}
              <span className="rounded-full border border-emerald-400/50 px-1.5 py-0.5 text-[10px] text-emerald-400">PoC-provable</span>{" "}
              impacts can be verified by executing the exploit.
            </p>
            {!info && <p className="text-sm text-muted-foreground">Loading impact catalogue…</p>}
            {info?.impacts.map((im) => {
              const on = picked.has(im.id);
              return (
                <label key={im.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${on ? "border-primary bg-primary/10" : "border-border hover:border-primary/50"}`}>
                  <Checkbox checked={on} onCheckedChange={() => toggle(im.id)} className="mt-0.5" />
                  <div className="grid gap-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {im.label}
                      <span className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase ${sevColor[im.severity]}`}>{im.severity}</span>
                      {im.machineCheckable && <span className="rounded-full border border-emerald-400/50 px-1.5 py-0.5 text-[10px] text-emerald-400">PoC-provable</span>}
                    </div>
                    <code className="text-[11px] text-muted-foreground">{im.id}</code>
                  </div>
                </label>
              );
            })}
          </CardContent>
        </Card>

        {/* Step 3 */}
        <Card>
          <CardHeader><StepHead n={3} title="Set the prices" /></CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-xs text-muted-foreground">
              Your call — the table just has to be monotonic (critical ≥ high ≥ … ). The <b className="text-foreground">critical</b> tier
              is the reward pool you must fund. Start from a preset, or size critical off funds-at-risk.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPayouts(info?.presets.onchain ?? ONCHAIN)}>On-chain preset</Button>
              <Button variant="outline" size="sm" onClick={() => setPayouts(info?.presets.web2 ?? WEB2)}>Web/app preset</Button>
              <div className="ml-auto flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">TVL $</span>
                <Input className="w-32" value={tvl} onChange={(e) => sizeCritical(e.target.value)} placeholder="500000" />
              </div>
            </div>
            <div className="grid max-w-md grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2">
              {SEVERITIES.map((s) => (
                <div key={s} className="contents">
                  <span className="text-sm capitalize text-muted-foreground">{s}</span>
                  <Input value={payouts[s]} onChange={(e) => setPay(s, e.target.value)} />
                </div>
              ))}
            </div>
            <p className={`text-xs ${payMsg.ok ? "text-emerald-400" : "text-rose-400"}`}>{payMsg.ok ? "✓ " : "✕ "}{payMsg.msg}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5"><Label>Hunter bond (step 1, USD)</Label>
                <Input value={bond} onChange={(e) => setBond(e.target.value)} /></div>
              <div className="grid gap-1.5"><Label>SLA — grade within</Label>
                <Select value={sla} onValueChange={(v) => setSla(v ?? "604800")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="86400">1 day</SelectItem>
                    <SelectItem value="259200">3 days</SelectItem>
                    <SelectItem value="604800">7 days</SelectItem>
                    <SelectItem value="1209600">14 days</SelectItem>
                  </SelectContent>
                </Select></div>
            </div>
            <div className="grid gap-1.5"><Label>Grading / funding wallet (ruler address)</Label>
              <Input value={ruler} onChange={(e) => setRuler(e.target.value)} placeholder="0x… — the wallet that grades and funds this bounty" /></div>
          </CardContent>
        </Card>

        {/* Verification */}
        <Card>
          <CardHeader><StepHead n={4} title="How submissions are verified" /></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Verification mode</Label>
              <Select value={vmode} onValueChange={(v) => setVmode((v as any) ?? "onchain-fork")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="onchain-fork">On-chain fork — PoC runs against a chain fork (smart contracts)</SelectItem>
                  <SelectItem value="company-attested">Company-attested — fork our repo, run the PoC (web / app)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {vmode === "company-attested" && (
              <div className="grid gap-4 rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  We clone this repo in a sandbox, run it, and replay the hunter’s PoC. Only a signed verdict leaves —
                  your code never does. Set one <b>assertion</b> (regex) per impact that proves it.
                </p>
                <div className="grid gap-1.5"><Label>Repo URL</Label>
                  <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/you/target" /></div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5"><Label>Build command (optional)</Label>
                    <Input value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} placeholder="bun install" /></div>
                  <div className="grid gap-1.5"><Label>Run command</Label>
                    <Input value={runCmd} onChange={(e) => setRunCmd(e.target.value)} placeholder="bun run demo-target/server.js" /></div>
                </div>
                {[...picked].length > 0 && (
                  <div className="grid gap-2">
                    <Label>Impact assertions (regex that must match the exploit’s effect)</Label>
                    {[...picked].map((id) => (
                      <div key={id} className="grid grid-cols-[160px_1fr] items-center gap-2">
                        <code className="truncate text-xs text-muted-foreground">{id}</code>
                        <Input value={assertions[id] ?? ""} onChange={(e) => setAssertions((a) => ({ ...a, [id]: e.target.value }))} placeholder="sk_live_.*LEAKED" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 5 */}
        <Card>
          <CardHeader><StepHead n={5} title="Create — commit the rules" done={!!created} /></CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-xs text-muted-foreground">This hashes your scope + payout table on chain. After this, they can’t move — that’s the point.</p>
            <div><Button onClick={create} disabled={busy || !payMsg.ok}>{busy ? "Creating…" : "Create bounty"}</Button></div>
            {created && (
              <div className="grid gap-1 pt-1 font-mono text-xs">
                <Separator className="my-2" />
                <div className="flex flex-wrap gap-2"><span className="min-w-28 text-muted-foreground">rulesHash</span><span className="break-all">{created.rulesHash}</span></div>
                <div className="flex flex-wrap gap-2"><span className="min-w-28 text-muted-foreground">on-chain tiers</span><span>[{created.onchain.tiers.join(", ")}]</span></div>
                <div className="flex flex-wrap gap-2"><span className="min-w-28 text-muted-foreground">ruler</span><span className="break-all">{created.onchain.ruler}</span></div>
                <div className="flex flex-wrap gap-2"><span className="min-w-28 text-muted-foreground">SLA</span><span>{created.onchain.slaSeconds / 86400} days</span></div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 5 */}
        <Card className={created ? "" : "opacity-50"}>
          <CardHeader><StepHead n={6} title="Fund the pool & verify" done={verify?.pool.solvent} /></CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              A hunter checks the pool covers a critical award before bonding. Send USDC to the ruler, then mark it funded.
              {created && <> Pool to fund: <b className="text-foreground">${created.rewardPoolUsd.toLocaleString()}</b>.</>}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="w-40" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} placeholder="amount USD" disabled={!created} />
              <Button variant="outline" onClick={() => fund(false)} disabled={!created}>Funding instructions</Button>
              <Button onClick={() => fund(true)} disabled={!created}>Mark funded</Button>
            </div>
            {verify && (
              <div className="grid gap-2 pt-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className={`h-2.5 w-2.5 rounded-full ${verify.verified ? "bg-emerald-500" : "bg-rose-500"}`} />
                  {verify.verified ? "rulesHash verified — served rules match the committed hash" : "hash mismatch"}
                </div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className={`h-2.5 w-2.5 rounded-full ${verify.pool.solvent ? "bg-emerald-500" : "bg-amber-500"}`} />
                  {verify.pool.solvent
                    ? `pool solvent — $${verify.pool.fundedUsd.toLocaleString()} covers a $${verify.pool.committedUsd.toLocaleString()} critical`
                    : `underfunded — $${verify.pool.fundedUsd.toLocaleString()} of $${verify.pool.committedUsd.toLocaleString()}`}
                </div>
                <div className="flex gap-2 pt-1">
                  <a href={`/api/programs/${created?.slug}/rules`} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm">rules JSON</Button></a>
                  <a href="/"><Button variant="outline" size="sm">back to landing →</Button></a>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
