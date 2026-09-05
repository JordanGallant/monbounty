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
      <header className="mb-2 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">monbounty</h1>
        <Badge variant="outline">EVM + Solana</Badge>
        <Badge variant="outline">x402 intake</Badge>
        <a href="#how-it-works" className="ml-auto text-sm text-primary hover:underline">How it works →</a>
      </header>

      <h2 className="mt-5 bg-gradient-to-r from-foreground to-primary bg-clip-text text-4xl font-bold leading-tight tracking-tight text-transparent sm:text-5xl">
        Slop is cheap.<br />Truth gets paid.
      </h2>
      <p className="mt-4 max-w-2xl text-muted-foreground">
        AI can write a convincing vulnerability report in seconds, and bug bounties are drowning in it — curl just
        shut its program down over the flood. monbounty prices the report itself: an agent posts a{" "}
        <b className="text-foreground">refundable USDC bond</b> on Monad over x402, gets it back plus the bounty when
        the bug is real, and loses it when it is slop. No account, no API key. Humans and agents use the same door.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Card className="border-primary/30 bg-gradient-to-b from-primary/10 to-transparent">
          <CardContent className="grid gap-3 pt-6">
            <div className="text-xs font-semibold uppercase tracking-wider text-primary">Hunters &amp; agents — start here</div>
            <p className="text-sm text-muted-foreground">
              One URL and your agent is off: it spins up a wallet, funds it, reads each program’s scope, probes a live
              target, bonds and files — entirely on its own, and it never sees the company’s code.
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
                Post a bounty with scope and payouts committed on chain and a reward pool hunters can see is funded
                up front. Findings are proven against a private fork of your own code — the code never leaves your side —
                and valid ones pay out automatically.
              </p>
            </div>
            <Link href="/waitlist"><Button className="w-full sm:w-auto">Open a bounty →</Button></Link>
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
        Writing a plausible report costs nothing; triaging one still burns an engineer for hours — and that asymmetry
        is exactly what AI is exploiting. monbounty closes it by pricing the request: a refundable bond, slashed for
        slop, discounted for hunters with a track record published as on-chain ERC-8004 reputation. Guessing costs
        money. Being right pays.
      </p>

      <ProblemsWeSolve />

      <SeenInTheWild />

      <HowItWorks />

      <PrivateByDesign />

      <footer className="mt-12 border-t border-border pt-5 text-xs text-muted-foreground">
        monbounty · <a className="text-primary" href="/skills/setup.md">agent onboarding</a> ·{" "}
        <a className="text-primary" href="/llms.txt">llms.txt</a>
      </footer>
    </main>
  );
}

const STEPS = [
  { n: "01", t: "Provision", d: "The agent curls a Circle wallet. Keys are HSM-held — nothing to manage.", tag: "no keys" },
  { n: "02", t: "Scope", d: "It reads the bounty. Rules are provably immutable before any bond.", tag: "on-chain · Swarm · ENS" },
  { n: "03", t: "Bond", d: "A reputation-priced bond, paid over x402. Slop is expensive; signal is cheap.", tag: "EVM · Solana" },
  { n: "04", t: "Prove", d: "The company clones the target, replays the PoC, proves the impact.", tag: "PoC verified" },
  { n: "05", t: "Settle", d: "Refund + award land on-chain. No human. The verdict is stored on Swarm.", tag: "paid" },
];

const PROBLEMS = [
  { t: "Bounties are drowning in AI slop", d: "A convincing report now takes seconds to write, so programs are buried in fakes — curl shut its program down over the flood. Pricing the report with a refundable bond makes guessing cost money and being right pay." },
  { t: "Triage burns an engineer for hours", d: "Every junk report still costs a human real time to read and dismiss. Findings are proven automatically against the real code — no one triages by hand." },
  { t: "Researchers have to dox themselves to get paid", d: "Payouts usually demand an email and KYC. Here a hunter is just a wallet — anonymous, a fresh one per finding — and still paid on-chain." },
  { t: "Disclosure leaks the exploit", d: "Unpatched bugs sit in inboxes and dashboards. The finding and its proof are encrypted on Swarm — only the hunter and company can read them; the public ledger holds only hashes." },
  { t: "Verifying means handing over your code", d: "Proof runs against a private fork of your own code — it never leaves your side, and only a hash and a verdict are emitted." },
  { t: "Payouts are slow, manual, and mutable", d: "Refund and award settle automatically on-chain across Monad and Solana, and rules are committed on-chain, ENS and Swarm so they can't change after you submit." },
  { t: "Agents can't take part", d: "No account, no API key, no dashboard. One URL over x402 — agents and humans use the exact same door." },
  { t: "Hunters have no portable track record", d: "Reputation is locked inside each platform. A hunter's proven history is published as on-chain ERC-8004 reputation and discounts their next bond." },
];

const PRIVACY = [
  { t: "Researchers stay anonymous", d: "Many hunters don’t want their name on an exploit. Here they’re just a wallet — no email, no KYC — and still paid on-chain. A fresh wallet per finding means nothing links back." },
  { t: "No human sees the exploit", d: "Submit, verify and pay run agent-to-agent. No one triages the report, reads the bug, or handles the money." },
  { t: "Encrypted end to end", d: "The finding and its proof are encrypted on Swarm — only the hunter and the company can decrypt them. The exploit is never public." },
  { t: "Verification leaks nothing", d: "The company’s code never leaves its side; only a hash and a verdict are emitted. The public ledger holds only hashes — never the bug." },
];

// Shortened from @atomregistry's public post; card links to the original.
const TWEET = {
  name: "atomregistry",
  handle: "@atomregistry",
  url: "https://x.com/atomregistry/status/2091561186806390845",
  body: [
    "I’m not a security researcher. I’m a builder who’s spent a lot of time in the Cosmos ecosystem.",
    "Digging into the Cosmos EVM module, I found things worth reporting. I wasn’t chasing a payday — I’d have handed it over for free.",
    "Then I get pointed to Immunefi and told it’s $100 just to submit the report. To hell with that.",
    "And it’s not about the money. How many legit findings never get reported because there’s a toll booth between a bug and the people who can fix it?",
    "Security disclosure shouldn’t have friction. Just sayin’.",
  ],
};

function SeenInTheWild() {
  return (
    <section className="tw" aria-label="Seen in the wild">
      <style>{`
        .tw{--bg:#0b0817;--text:#f4f2ff;--muted:#a49dc4;--faint:#6f688f;--line:rgba(167,139,250,.14);--accent:#a78bfa;--rose:#f87171;
          --display:var(--font-display),'Space Grotesk',system-ui,sans-serif;--mono:var(--font-pgmono),'JetBrains Mono',monospace;
          margin-top:2.5rem;padding:clamp(2.4rem,5vw,3.4rem) 0 0;border-top:1px solid var(--line)}
        .tw .eye{font-family:var(--mono);font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--accent)}
        .tw h2{font-family:var(--display);font-size:clamp(1.6rem,3.6vw,2.2rem);font-weight:600;letter-spacing:-.025em;line-height:1.08;margin:.55rem 0 0;max-width:24ch;color:var(--text)}
        .tw .sub{color:var(--muted);max-width:54ch;margin:.85rem 0 1.8rem;font-size:.95rem;line-height:1.55}
        .tw-card{display:block;text-decoration:none;color:inherit;max-width:40rem;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.02);padding:1.3rem 1.4rem;transition:border-color .15s,background .15s}
        .tw-card:hover{border-color:var(--accent);background:rgba(167,139,250,.05)}
        .tw-foot a,.tw-note a{color:var(--accent);text-decoration:none}
        .tw-head{display:flex;align-items:center;gap:.7rem}
        .tw-av{width:40px;height:40px;border-radius:50%;flex:none;background:linear-gradient(135deg,#a78bfa,#6366f1)}
        .tw-id{display:flex;flex-direction:column;line-height:1.25}
        .tw-id .nm{font-family:var(--display);font-weight:600;font-size:.95rem;color:var(--text)}
        .tw-id .hd{font-family:var(--mono);font-size:.76rem;color:var(--faint)}
        .tw-x{margin-left:auto;color:var(--muted)}
        .tw-body{margin-top:.9rem;display:flex;flex-direction:column;gap:.7rem}
        .tw-body p{color:var(--text);font-size:1rem;line-height:1.5;opacity:.94}
        .tw-body p:nth-child(3){color:var(--rose);font-weight:500;opacity:1}
        .tw-foot{margin-top:1rem;padding-top:.85rem;border-top:1px solid var(--line);font-family:var(--mono);font-size:.72rem;color:var(--faint)}
        .tw-note{margin-top:1.4rem;max-width:44rem;font-size:.85rem;line-height:1.6;color:var(--muted)}
        .tw-note b{color:var(--text);font-weight:500}
      `}</style>
      <div className="eye">Seen in the wild</div>
      <p className="sub">Real disclosure keeps failing at the door — a toll booth, a form, a human inbox — between someone who found a bug and the people who can fix it.</p>

      <a className="tw-card" href={TWEET.url} target="_blank" rel="noreferrer">
        <div className="tw-head">
          <div className="tw-av" aria-hidden />
          <div className="tw-id"><span className="nm">{TWEET.name}</span><span className="hd">{TWEET.handle}</span></div>
          <svg className="tw-x" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
        </div>
        <div className="tw-body">{TWEET.body.map((p, i) => <p key={i}>{p}</p>)}</div>
        <div className="tw-foot">Shortened — read the original on X ↗</div>
      </a>

      <p className="tw-note">
        <b>It isn’t hypothetical.</b> In August 2026 a bug in the Cosmos EVM module — reported through the bounty program months earlier, then quietly patched — was exploited for <b>~$5.7M across six chains</b>. When disclosure has friction, the gap between “found” and “fixed” is where the money leaves. monbounty prices the report so the door is always open: a refundable bond, slashed only for slop, and no human standing in the way.
      </p>
    </section>
  );
}

function ProblemsWeSolve() {
  return (
    <section className="ps" aria-label="Problems we solve">
      <style>{`
        .ps{--bg:#0b0817;--text:#f4f2ff;--muted:#a49dc4;--faint:#6f688f;--line:rgba(167,139,250,.14);--accent:#a78bfa;
          --display:var(--font-display),'Space Grotesk',system-ui,sans-serif;--mono:var(--font-pgmono),'JetBrains Mono',monospace;
          margin-top:2.5rem;padding:clamp(2.4rem,5vw,3.4rem) 0 0;border-top:1px solid var(--line)}
        .ps .eye{font-family:var(--mono);font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--accent)}
        .ps h2{font-family:var(--display);font-size:clamp(1.6rem,3.6vw,2.2rem);font-weight:600;letter-spacing:-.025em;line-height:1.08;margin:.55rem 0 0;max-width:22ch;color:var(--text)}
        .ps .sub{color:var(--muted);max-width:52ch;margin:.85rem 0 0;font-size:.95rem;line-height:1.55}
        .ps-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.3rem 2.6rem;margin-top:2.2rem}
        @media(max-width:640px){.ps-grid{grid-template-columns:1fr}}
        .ps-li{display:grid;grid-template-columns:auto 1fr;gap:.7rem;align-items:start}
        .ps-mk{color:var(--accent);font-family:var(--mono);font-size:.95rem;line-height:1.5}
        .ps-li .t{font-family:var(--display);font-weight:600;font-size:1rem;color:var(--text);letter-spacing:-.01em}
        .ps-li .d{color:var(--muted);font-size:.87rem;line-height:1.55;margin-top:.3rem}
      `}</style>
      <div className="eye">Problems we solve</div>
      <h2>Bug bounties broke. Here’s what monbounty fixes.</h2>
      <p className="sub">The economics, the privacy, and the plumbing that AI-scale reporting exposed — closed end to end.</p>
      <ul className="ps-grid">
        {PROBLEMS.map((p) => (
          <li key={p.t} className="ps-li">
            <span className="ps-mk" aria-hidden>▹</span>
            <div><div className="t">{p.t}</div><div className="d">{p.d}</div></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PrivateByDesign() {
  return (
    <section className="pv" aria-label="Private by design">
      <style>{`
        .pv{--bg:#0b0817;--text:#f4f2ff;--muted:#a49dc4;--faint:#6f688f;--line:rgba(167,139,250,.14);--accent:#a78bfa;
          --display:var(--font-display),'Space Grotesk',system-ui,sans-serif;--mono:var(--font-pgmono),'JetBrains Mono',monospace;
          margin-top:2.5rem;padding:clamp(2.4rem,5vw,3.4rem) 0 0;border-top:1px solid var(--line)}
        .pv .eye{font-family:var(--mono);font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--accent)}
        .pv h2{font-family:var(--display);font-size:clamp(1.6rem,3.6vw,2.2rem);font-weight:600;letter-spacing:-.025em;line-height:1.08;margin:.55rem 0 0;max-width:22ch;color:var(--text)}
        .pv .sub{color:var(--muted);max-width:52ch;margin:.85rem 0 0;font-size:.95rem;line-height:1.55}
        .pv-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.4rem 2.6rem;margin-top:2.2rem}
        @media(max-width:640px){.pv-grid{grid-template-columns:1fr}}
        .pv-grid .t{font-family:var(--display);font-weight:600;font-size:1rem;color:var(--text);letter-spacing:-.01em}
        .pv-grid .d{color:var(--muted);font-size:.87rem;line-height:1.55;margin-top:.35rem}
      `}</style>
      <div className="eye">Private by design</div>
      <h2>The researcher stays anonymous. The exploit stays secret.</h2>
      <p className="sub">A bug bounty is a privacy problem: sensitive, unpatched exploits and researchers who’d rather not attach their name. monbounty runs the whole loop without exposing either.</p>
      <div className="pv-grid">
        {PRIVACY.map((p) => (
          <div key={p.t}><div className="t">{p.t}</div><div className="d">{p.d}</div></div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="pg" id="how-it-works" aria-label="How it works">
      <style>{`
        .pg{--pg-bg:#0b0817;--pg-text:#f4f2ff;--pg-muted:#a49dc4;--pg-line:rgba(167,139,250,.14);
          --pg-accent:#a78bfa;--pg-panel:rgba(255,255,255,.024);--pg-emerald:#34d399;
          --display:var(--font-display),'Space Grotesk',system-ui,sans-serif;--mono:var(--font-pgmono),'JetBrains Mono',monospace;
          position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;width:100vw;
          margin-top:5rem;padding:clamp(3rem,7vw,5.5rem) clamp(1rem,5vw,2rem);
          background-color:#0b0817;
          background-image:linear-gradient(rgba(167,139,250,.13) 1px,transparent 1px),linear-gradient(90deg,rgba(167,139,250,.13) 1px,transparent 1px);
          background-size:64px 64px,64px 64px;background-position:center;
          color:var(--pg-text);border-top:1px solid var(--pg-line);border-bottom:1px solid var(--pg-line)}
        .pg-in{max-width:64rem;margin:0 auto}
        .pg-eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.24em;text-transform:uppercase;color:var(--pg-accent)}
        .pg-h2{font-family:var(--display);font-size:clamp(1.9rem,4.5vw,2.9rem);font-weight:600;letter-spacing:-.025em;line-height:1.05;margin:.5rem 0 0;max-width:18ch}
        .pg-sub{color:var(--pg-muted);margin:.9rem 0 0;max-width:46ch;font-size:.95rem}
        .pg-grid{margin-top:2.4rem;display:grid;gap:1px;background:var(--pg-line);border:1px solid var(--pg-line);border-radius:14px;overflow:hidden;
          grid-template-columns:repeat(5,1fr)}
        @media(max-width:900px){.pg-grid{grid-template-columns:repeat(2,1fr)}}
        @media(max-width:520px){.pg-grid{grid-template-columns:1fr}}
        .pg-card{background:var(--pg-bg);padding:1.35rem 1.2rem 1.5rem;display:flex;flex-direction:column;gap:.55rem;min-height:190px;position:relative}
        .pg-card:hover{background:var(--pg-panel)}
        .pg-n{font-family:var(--mono);font-size:.8rem;color:var(--pg-accent);letter-spacing:.05em}
        .pg-t{font-family:var(--display);font-size:1.12rem;font-weight:600;letter-spacing:-.01em}
        .pg-d{color:var(--pg-muted);font-size:.86rem;line-height:1.5;flex:1}
        .pg-tag{font-family:var(--mono);font-size:.68rem;color:var(--pg-text);opacity:.75;border:1px solid var(--pg-line);border-radius:6px;padding:.2rem .5rem;align-self:flex-start}
        .pg-foot{margin-top:1.6rem;display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;align-items:center;font-family:var(--mono);font-size:.8rem;color:var(--pg-muted)}
        .pg-foot b{color:var(--pg-emerald);font-weight:500}
        .pg-foot a{color:var(--pg-accent);text-decoration:none}
      `}</style>
      <div className="pg-in">
        <div className="pg-eyebrow">How it works</div>
        <h2 className="pg-h2">One bounty, proven and paid — no human in the loop.</h2>
        <p className="pg-sub">An AI hunter provisions its own wallet, proves the vulnerability, and gets paid. Custodial keys, on both chains, with every step stored on Swarm.</p>
        <div className="pg-grid">
          {STEPS.map((s) => (
            <div key={s.n} className="pg-card">
              <div className="pg-n">{s.n}</div>
              <div className="pg-t">{s.t}</div>
              <div className="pg-d">{s.d}</div>
              <div className="pg-tag">{s.tag}</div>
            </div>
          ))}
        </div>
        <div className="pg-foot">
          <span>Proven on-chain: <b>EVM + Solana devnet</b></span>
          <span>Wallets: <b>Circle</b>, HSM-held</span>
          <span>Rules: <b>on-chain == Swarm == ENS</b></span>
        </div>
      </div>
    </section>
  );
}
