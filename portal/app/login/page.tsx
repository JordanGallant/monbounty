"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") || "/dashboard";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setErr(error.message);
    router.push(next);
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-xl font-semibold tracking-tight">monbounty</span>
            <span className="text-xs text-muted-foreground">company sign-in</span>
          </div>
          <CardTitle className="text-sm font-normal text-muted-foreground">
            Manage your bounty programs, submissions and payouts.
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
            <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}
