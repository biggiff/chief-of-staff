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

  // Build the brief as clean lines/sections (Telegram renders \n and • bullets).
  // NOTE: Oura readiness is intentionally NOT in the morning brief — the ring
  // doesn't sync until she opens the app, so a 7am pull is yesterday's data.
  // Readiness stays available on demand (ask Scout once it's synced).
  const lines: string[] = ["☀️ Good morning"];

  // Lead with open commitments she hasn't closed — so nothing she committed to
  // quietly disappears. These are the accountability loop's resurfacing surface.
  try {
    const { openCommitments } = await import("@/lib/operator");
    const open = await openCommitments(5);
    if (open.length) {
      lines.push("", "🎯 Still open");
      for (const c of open) lines.push(`• ${c.text}`);
      lines.push('Reply "done", "too big", or "drop it" on any.');
    }
  } catch (err) {
    console.error("morning commitments failed", err);
  }

  lines.push("", "📅 Today");
  if (events.length) for (const e of events.slice(0, 6)) lines.push(`• ${e}`);
  else lines.push("• Nothing scheduled");

  lines.push("", "✅ Due");
  if (dueTitles.length) {
    for (const t of dueTitles) lines.push(`• ${t}`);
    if (due.length > 4) lines.push(`• +${due.length - 4} more`);
  } else {
    lines.push("• Nothing due — clear plate");
  }

  lines.push("", "Text me to add or knock anything out.");

  const res = await notifyOwner(lines.join("\n"));

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
