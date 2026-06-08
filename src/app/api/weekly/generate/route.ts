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
    return NextResponse.json({ ok: true, weekOf: review.weekOf, id: review.id });
  } catch (err) {
    console.error("weekly generate failed", err);
    return NextResponse.json({ ok: false, error: "Generation failed." }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
