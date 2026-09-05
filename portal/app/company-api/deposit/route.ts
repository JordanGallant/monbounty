// Create a top-up for the logged-in company — by card (Stripe) or crypto. The
// owner_ref is the Supabase email, bound server-side; the client only chooses
// method + amount.
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3044";
const ADMIN = process.env.ADMIN_TOKEN ?? "";

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const method = body?.method === "crypto" ? "crypto" : "stripe";
  const path = method === "crypto" ? "/api/v1/deposits/crypto" : "/api/v1/deposits/stripe";
  const r = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({
      ownerRef: user.email,
      amountUsd: Number(body?.amountUsd ?? 0),
      kind: "company",
      network: body?.network,
    }),
  });
  return NextResponse.json(await r.json(), { status: r.status });
}
