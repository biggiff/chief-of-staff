import { NextRequest, NextResponse } from "next/server";
import { appTimeZone, todayStr } from "@/lib/dates";
import { getSetting, setSetting } from "@/lib/operator";
import { notifyOwner } from "@/lib/integrations/notify";
import { getTodaySteps, ouraEnabled } from "@/lib/integrations/oura";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Pace ladder: by this hour (user's tz), you should be at this fraction of goal.
const CHECKPOINTS = [
  { hour: 12, frac: 0.27, label: "noon" },
  { hour: 15, frac: 0.5, label: "3pm" },
  { hour: 18, frac: 0.73, label: "6pm" },
  { hour: 20, frac: 0.9, label: "8pm" },
];

function phoenixHour(): number {
  return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: appTimeZone(), hour: "2-digit", hour12: false }).format(new Date()), 10) % 24;
}

/** Cron-triggered a few times a day. Nudges if she's behind her step pace. */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ouraEnabled()) return NextResponse.json({ ok: false, error: "Oura not connected." });

  const goal = parseInt((await getSetting("step_goal")) || "7500", 10);
  const hour = phoenixHour();
  // Use the checkpoint at (or most recently passed before) the current hour.
  const cp = [...CHECKPOINTS].reverse().find((c) => hour >= c.hour);
  if (!cp) return NextResponse.json({ ok: true, skipped: "before first checkpoint" });

  const steps = await getTodaySteps();
  if (steps == null) return NextResponse.json({ ok: true, skipped: "no step data yet" });

  const target = Math.round((goal * cp.frac) / 100) * 100;
  const today = todayStr();
  const nudgedKey = `steps_nudged_${today}`;
  const already = ((await getSetting(nudgedKey)) || "").split(",").filter(Boolean);

  // On pace / done, or already nudged this checkpoint → stay quiet.
  if (steps >= goal || steps >= target || already.includes(String(cp.hour))) {
    return NextResponse.json({ ok: true, steps, target, nudged: false });
  }

  const gap = target - steps;
  await notifyOwner(`👟 ${steps.toLocaleString()} steps so far — aim is ~${target.toLocaleString()} by ${cp.label} (goal ${goal.toLocaleString()}). You're ${gap.toLocaleString()} behind; a quick walk closes it.`);
  await setSetting(nudgedKey, [...already, String(cp.hour)].join(","));
  return NextResponse.json({ ok: true, steps, target, nudged: true });
}

export const GET = run;
export const POST = run;
