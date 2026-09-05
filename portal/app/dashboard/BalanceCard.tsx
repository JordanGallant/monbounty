"use client";

// The unified balance surface: one USD balance the company tops up by card
// (Stripe) or crypto, funds pools from, and withdraws back to its own wallet.
// The chain is hidden by default; crypto is just another rail. Mirrors the
// fomo.family "deposit once, we route it" experience.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { toast } from "sonner";

interface Balance {
  balanceUsd: number;
  deposits: { id: string; rail: string; usd: number; status: string; chainTx: string | null; createdAt: string }[];
  withdrawals: { id: string; usd: number; to: string; status: string; chainTx: string | null }[];
  history: { usd: number; memo: string | null; at: string }[];
}
interface CryptoInfo { to: string; sendExactUsdc: number; token: string; network: string }

const TESTNET = "eip155:10143";
const usd = (n: number) => `$${n.toFixed(2)}`;

export default function BalanceCard() {
  const [bal, setBal] = useState<Balance | null>(null);
  const [panel, setPanel] = useState<"none" | "add" | "withdraw">("none");
  const [amount, setAmount] = useState("50");
  const [crypto, setCrypto] = useState<CryptoInfo | null>(null);
  const [wdAddr, setWdAddr] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api<Balance>("/company-api/balance").then(setBal).catch(() => setBal(null));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000); // catch crypto deposits + webhook credits
    return () => clearInterval(t);
  }, [refresh]);

  async function payCard() {
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/company-api/deposit", {
        method: "POST", body: JSON.stringify({ method: "stripe", amountUsd: Number(amount) }),
      });
      window.location.href = r.url; // hosted Stripe Checkout
    } catch (e: any) { toast.error(e.message ?? "checkout failed"); setBusy(false); }
  }

  async function depositCrypto() {
    setBusy(true);
    try {
      const r = await api<CryptoInfo>("/company-api/deposit", {
        method: "POST", body: JSON.stringify({ method: "crypto", amountUsd: Number(amount), network: TESTNET }),
      });
      setCrypto(r);
      toast.success("Send the exact amount — your balance updates automatically.");
    } catch (e: any) { toast.error(e.message ?? "could not start crypto deposit"); }
    setBusy(false);
  }

  async function withdraw() {
    setBusy(true);
    try {
      await api("/company-api/withdraw", {
        method: "POST", body: JSON.stringify({ amountUsd: Number(amount), toAddress: wdAddr, network: TESTNET }),
      });
      toast.success("Withdrawal sent on-chain.");
      setPanel("none"); refresh();
    } catch (e: any) { toast.error(e.message ?? "withdrawal failed"); }
    setBusy(false);
  }

  return (
    <Card className="mb-6">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <div className="text-xs text-muted-foreground">Balance</div>
          <div className="text-2xl font-semibold tracking-tight">{bal ? usd(bal.balanceUsd) : "—"}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Fund pools with this. Top up by card or crypto; withdraw to your own wallet anytime.
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => { setPanel(panel === "add" ? "none" : "add"); setCrypto(null); }}>Add funds</Button>
          <Button size="sm" variant="outline" onClick={() => setPanel(panel === "withdraw" ? "none" : "withdraw")}>Withdraw</Button>
        </div>
      </CardHeader>

      {panel !== "none" && (
        <CardContent className="pt-2">
          <Separator className="mb-4" />
          <div className="grid gap-3 sm:max-w-sm">
            <div className="grid gap-1.5">
              <Label htmlFor="amt">Amount (USD)</Label>
              <Input id="amt" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>

            {panel === "add" && !crypto && (
              <div className="flex gap-2">
                <Button className="flex-1" disabled={busy} onClick={payCard}>Pay with card</Button>
                <Button className="flex-1" variant="outline" disabled={busy} onClick={depositCrypto}>Deposit crypto</Button>
              </div>
            )}

            {panel === "add" && crypto && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
                <div className="mb-1 font-medium">Send exactly this USDC on Monad testnet:</div>
                <div className="mb-2 text-base font-semibold text-primary">{crypto.sendExactUsdc} USDC</div>
                <div className="text-muted-foreground">to address</div>
                <div className="break-all font-mono">{crypto.to}</div>
                <div className="mt-2 text-muted-foreground">Credited automatically once seen on-chain (within ~10s of confirmation).</div>
              </div>
            )}

            {panel === "withdraw" && (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="wd">Destination address (Monad)</Label>
                  <Input id="wd" placeholder="0x…" value={wdAddr} onChange={(e) => setWdAddr(e.target.value)} />
                </div>
                <Button disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(wdAddr)} onClick={withdraw}>
                  Withdraw {usd(Number(amount) || 0)}
                </Button>
              </>
            )}
          </div>

          {bal && bal.history.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Recent activity</div>
              <div className="grid gap-1 text-xs">
                {bal.history.slice(0, 6).map((h, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{h.memo}</span>
                    <span className={h.usd >= 0 ? "text-emerald-400" : "text-rose-400"}>
                      {h.usd >= 0 ? "+" : ""}{usd(h.usd)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
