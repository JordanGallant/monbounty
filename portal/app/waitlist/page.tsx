"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function WaitlistPage() {
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [message, setMessage] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api("/api/waitlist", { method: "POST", body: JSON.stringify({ company, email, website, message }) });
      setDone(true);
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setErr(m === "bad_email" ? "Please enter a valid email." : m === "company_required" ? "Please enter your company name." : "Something went wrong — try again.");
    } finally { setBusy(false); }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-xl font-semibold tracking-tight">monbounty</span>
            <span className="text-xs text-muted-foreground">open a bounty</span>
          </div>
          <CardTitle className="text-sm font-normal text-muted-foreground">
            Onboarding is invite-only right now. Tell us about your program and we'll reach out to get you set up.
          </CardTitle>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="grid gap-4">
              <Alert>
                <AlertDescription>
                  Thanks — you're on the list. We'll email you at <span className="font-medium">{email}</span> to get you onboarded.
                </AlertDescription>
              </Alert>
              <Link href="/" className="text-sm text-primary hover:underline">← Back to monbounty</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="company">Company *</Label>
                <Input id="company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Inc." required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="email">Work email *</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@acme.com" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="website">Website / target to test</Label>
                <Input id="website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://acme.com" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="message">What do you want to secure?</Label>
                <Textarea id="message" value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="A few words on the app/infra and what you'd like hunters to look for." />
              </div>
              {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
              <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Request onboarding →"}</Button>
              <p className="text-center text-xs text-muted-foreground">
                Already onboarded? <Link href="/login" className="underline">Sign in</Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
