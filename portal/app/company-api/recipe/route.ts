// Supabase-authed bridge to the admin-gated recipe endpoint. The browser can't
// hold the ADMIN_TOKEN, so a logged-in company edits its bounty's verification
// recipe through here: we verify the Supabase session, then call the backend
// with the token held server-side.
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3044";
const ADMIN = process.env.ADMIN_TOKEN ?? "";

async function requireUser() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET(req: NextRequest) {
  if (!(await requireUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const r = await fetch(`${BACKEND}/api/programs/${slug}/recipe`, { headers: { authorization: `Bearer ${ADMIN}` } });
  return NextResponse.json(await r.json(), { status: r.status });
}

export async function PUT(req: NextRequest) {
  if (!(await requireUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const slug = body?.slug;
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const r = await fetch(`${BACKEND}/api/programs/${slug}/recipe`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return NextResponse.json(await r.json(), { status: r.status });
}
