import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Auth policy:
//  - app.monbounty.xyz is the company app — every page requires a Supabase
//    session (except /login), and its root goes to the dashboard.
//  - /dashboard is protected on any host.
//  - The apex (marketing + public bounty browse) stays open.
//  - /api and /skills are proxied to the backend (own auth) — never gated here.
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api") || pathname.startsWith("/skills") || pathname === "/llms.txt") {
    return NextResponse.next();
  }

  const host = request.headers.get("host") ?? "";
  const isAppHost = host.startsWith("app.");
  const { response, user } = await updateSession(request);

  const needsAuth = pathname.startsWith("/dashboard") || pathname.startsWith("/company") || (isAppHost && pathname !== "/login");

  if (isAppHost && pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = user ? "/dashboard" : "/login";
    return NextResponse.redirect(url);
  }
  if (needsAuth && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (pathname === "/login" && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
