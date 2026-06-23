import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authEnabled, expectedToken } from "@/lib/auth";

/**
 * Gate every request behind the app password when APP_PASSWORD is set.
 * Unauthenticated page requests redirect to /login; API requests get a 401.
 */
export async function middleware(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  // Login + the PWA manifest must be reachable while logged out. The weekly cron
  // route self-authenticates via CRON_SECRET, so it bypasses the password gate.
  if (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname === "/" ||                  // public landing page (verifiable website for A2P)
    pathname === "/manifest.webmanifest" ||
    pathname === "/privacy" ||           // public — carriers must crawl it for A2P
    pathname === "/api/weekly/generate" ||
    pathname === "/api/sms" ||           // Twilio webhook — auth'd by signature + allowlist
    pathname === "/api/sms/morning" ||   // cron — auth'd by CRON_SECRET
    pathname === "/api/reminders/tick" || // cron — auth'd by CRON_SECRET
    pathname === "/api/steps/check" ||    // cron — auth'd by CRON_SECRET
    pathname === "/api/telegram"         // Telegram webhook — auth'd by secret token + chat allowlist
  ) {
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
