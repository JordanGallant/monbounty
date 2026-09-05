// Supabase-authed bridge to the custodial balance. The browser never holds the
// ADMIN_TOKEN or gets to pick whose balance it reads: we take the owner_ref from
// the verified Supabase session (the company's email) and the backend trusts the
// admin token to assert it.
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3044";
const ADMIN = process.env.ADMIN_TOKEN ?? "";

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await fetch(`${BACKEND}/api/v1/balance?ownerRef=${encodeURIComponent(user.email)}`, {
    headers: { authorization: `Bearer ${ADMIN}` }, cache: "no-store",
  });
  return NextResponse.json(await r.json(), { status: r.status });
}
