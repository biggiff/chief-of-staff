import { NextRequest, NextResponse } from "next/server";
import { todayStr } from "@/lib/dates";
import { getSetting, setSetting } from "@/lib/operator";
import { notifyOwner } from "@/lib/integrations/notify";
import { getWorkoutStats, hevyEnabled } from "@/lib/integrations/hevy";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Daily (cron) workout-consistency nudge — firm but kind. If she's gone longer
 * than her target gap without logging a workout in Hevy, nudge once, then back
 * off (no re-nudge within 2 days). Silent if she's on track or has never logged
 * a workout (don't nag someone who isn't using it yet). CRON_SECRET-authed.
 */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hevyEnabled()) return NextResponse.json({ ok: false, error: "Hevy not connected." });

  const today = todayStr();
  const goal = Math.max(1, parseInt((await getSetting("workout_goal")) || "3", 10)); // workouts/week
  const threshold = Math.max(2, Math.round(7 / goal) + 1); // e.g. goal 3 → nudge after ~3 quiet days

  const { lastDate, daysSince, last7 } = await getWorkoutStats(today);
  if (daysSince == null) return NextResponse.json({ ok: true, skipped: "no workouts logged yet" });
  if (daysSince < threshold) return NextResponse.json({ ok: true, onTrack: true, daysSince, last7 });

  // Behind target — but don't re-nudge within 2 days (firm, not naggy).
  const lastNudge = await getSetting("workout_last_nudge");
  if (lastNudge) {
    const gap = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastNudge}T00:00:00Z`)) / 86_400_000;
    if (gap < 2) return NextResponse.json({ ok: true, recentlyNudged: true, daysSince });
  }

  const dayWord = daysSince === 1 ? "day" : "days";
  await notifyOwner(
    `💪 It's been ${daysSince} ${dayWord} since your last workout (${last7} this week). Want to get one in today? Reply "done" when you do — or "rest" if it's a deliberate rest day and I'll ease off.`
  );
  await setSetting("workout_last_nudge", today);
  return NextResponse.json({ ok: true, nudged: true, daysSince, last7, lastDate });
}

export const GET = run;
export const POST = run;
