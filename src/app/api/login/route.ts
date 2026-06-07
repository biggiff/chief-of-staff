import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, expectedToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = (form.get("password") ?? "").toString();
  const nextRaw = (form.get("next") ?? "/chat").toString();
  const next = nextRaw.startsWith("/") ? nextRaw : "/chat";
  const origin = req.nextUrl.origin;

  if (password && password === process.env.APP_PASSWORD) {
    const res = NextResponse.redirect(new URL(next, origin), { status: 303 });
    res.cookies.set(AUTH_COOKIE, await expectedToken(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return res;
  }

  return NextResponse.redirect(
    new URL(`/login?error=1&next=${encodeURIComponent(next)}`, origin),
    { status: 303 }
  );
}
