import { NextRequest, NextResponse } from "next/server";
import { and, eq, lte } from "drizzle-orm";
import { db, tasks as tasksTable } from "@/db";
import { startEndOfToday, formatTime } from "@/lib/dates";
import { notifyOwner, ownerReachable } from "@/lib/integrations/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Sunday-through-Saturday morning text: a short, OPERATIONAL brief (today's
 * commitments + what's due). Cron-triggered (see vercel.json); CRON_SECRET-authed.
 * Template-based on purpose — instant, free, reliable, and on-message.
 */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await ownerReachable())) return NextResponse.json({ ok: false, error: "No messaging channel configured." });

  const { end } = startEndOfToday();

  // Today's calendar across all connected calendars.
  let events: string[] = [];
  try {
    const { calendarEnabled, listTodaysEvents } = await import("@/lib/integrations/google-calendar");
    if (calendarEnabled()) {
      events = (await listTodaysEvents()).map((e) =>
        (e.allDay ? e.title : `${formatTime(e.start)} ${e.title}`) + (e.isPrimary ? "" : ` (${e.calendar})`)
      );
    }
  } catch (err) {
    console.error("morning calendar failed", err);
  }

  // Open tasks due today or overdue.
  const due = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.status, "open"), lte(tasksTable.dueDate, end)));
  const dueTitles = due.slice(0, 4).map((t) => t.title);

  const parts: string[] = ["☀️ Morning."];

  // Body readiness from Oura, if connected — leads the brief so she knows the kind of day.
  try {
    const { getOuraData, ouraEnabled } = await import("@/lib/integrations/oura");
    if (ouraEnabled()) {
      const o = (await getOuraData(2))?.latest;
      if (o?.readiness != null) {
        const sleep = o.sleepHours != null ? `, slept ${o.sleepHours}h` : "";
        const band = o.readiness >= 85 ? "well-recovered — good day to push" : o.readiness >= 70 ? "decent recovery" : "running low — take it easy";
        parts.push(`Readiness ${o.readiness}${sleep} — ${band}.`);
      }
    }
  } catch (err) {
    console.error("morning oura failed", err);
  }

  parts.push(events.length ? `Today: ${events.slice(0, 5).join(", ")}.` : "Nothing on the calendar today.");
  if (dueTitles.length) {
    parts.push(`Due: ${dueTitles.join(", ")}${due.length > 4 ? `, +${due.length - 4} more` : ""}.`);
  } else {
    parts.push("Nothing due — clear plate.");
  }
  parts.push("Text me to add or knock anything out.");

  const res = await notifyOwner(parts.join(" "));

  // Google-token health check — alert ONCE per outage (not every morning), and
  // confirm once when it recovers. Turns a silent calendar failure into a nudge.
  try {
    const { calendarEnabled, calendarAuthOk } = await import("@/lib/integrations/google-calendar");
    const { getSetting, setSetting } = await import("@/lib/operator");
    if (calendarEnabled()) {
      const ok = await calendarAuthOk();
      const alerted = (await getSetting("cal_auth_alerted")) === "yes";
      if (!ok && !alerted) {
        await notifyOwner("⚠️ Heads up — Google needs reconnecting. Your calendar isn't reading right now, so your brief is missing events. Reply here when you're ready and I'll walk you through the 2-minute reconnect.");
        await setSetting("cal_auth_alerted", "yes");
      } else if (ok && alerted) {
        await setSetting("cal_auth_alerted", "no");
        await notifyOwner("✅ Google calendar's reconnected — back to normal.");
      }
    }
  } catch (err) {
    console.error("calendar health check failed", err);
  }

  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}

export const GET = run;
export const POST = run;
