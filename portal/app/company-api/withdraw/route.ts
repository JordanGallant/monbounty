// Withdraw the company's balance to a wallet address it controls (the escape
// hatch back to self-custody). owner_ref bound from the Supabase session.
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3044";
const ADMIN = process.env.ADMIN_TOKEN ?? "";

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const r = await fetch(`${BACKEND}/api/v1/withdrawals`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({
      ownerRef: user.email,
      amountUsd: Number(body?.amountUsd ?? 0),
      toAddress: body?.toAddress,
      network: body?.network,
    }),
  });
  return NextResponse.json(await r.json(), { status: r.status });
}
