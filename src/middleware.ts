import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authEnabled, expectedToken } from "@/lib/auth";

/**
 * Gate every request behind the app password when APP_PASSWORD is set.
 * Unauthenticated page requests redirect to /login; API requests get a 401.
 */
export async function middleware(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  // Login + the PWA manifest must be reachable while logged out.
  if (pathname === "/login" || pathname === "/api/login" || pathname === "/manifest.webmanifest") {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  const ok = !!cookie && cookie === (await expectedToken());
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "Authentication required." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
