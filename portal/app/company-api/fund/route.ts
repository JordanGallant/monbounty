// Fund a bounty's reward pool from the company's balance (chain hidden). Only a
// company that owns a program should fund it; ownership is by the Supabase
// session (owner_ref), and the backend records the funding against the pool.
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3044";
const ADMIN = process.env.ADMIN_TOKEN ?? "";

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const slug = body?.slug;
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const r = await fetch(`${BACKEND}/api/programs/${slug}/fund-from-balance`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ ownerRef: user.email, amountUsd: Number(body?.amountUsd ?? 0) }),
  });
  return NextResponse.json(await r.json(), { status: r.status });
}
