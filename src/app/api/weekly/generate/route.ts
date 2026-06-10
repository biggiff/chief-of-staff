import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyReview } from "@/lib/weekly-review";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Generates the weekly review. Invoked by Vercel Cron on Sunday evening (see
 * vercel.json). Excluded from the app-password middleware; authenticates instead
 * via CRON_SECRET (Vercel sends it as `Authorization: Bearer <secret>` when set).
 */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const review = await generateWeeklyReview();
    // Nudge over SMS if configured — a short text, the full review lives in the app.
    try {
      const { smsEnabled, ownerPrimaryPhone, sendSms } = await import("@/lib/integrations/sms");
      const to = ownerPrimaryPhone();
      if (smsEnabled() && to) {
        const tl = review.throughline ? ` ${review.throughline}` : "";
        await sendSms(to, `🗓️ Your weekly review's ready.${tl} Open the app for the full read, or text me "weekly review" for the rundown.`);
      }
    } catch (err) {
      console.error("weekly sms nudge failed", err);
    }
    return NextResponse.json({ ok: true, weekOf: review.weekOf, id: review.id });
  } catch (err) {
    console.error("weekly generate failed", err);
    return NextResponse.json({ ok: false, error: "Generation failed." }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
