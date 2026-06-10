import { NextRequest, NextResponse } from "next/server";
import { and, eq, lte } from "drizzle-orm";
import { db, tasks as tasksTable } from "@/db";
import { startEndOfToday, formatTime } from "@/lib/dates";
import { smsEnabled, ownerPrimaryPhone, sendSms } from "@/lib/integrations/sms";

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
  const to = ownerPrimaryPhone();
  if (!smsEnabled() || !to) return NextResponse.json({ ok: false, error: "SMS not configured." });

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
  parts.push(events.length ? `Today: ${events.slice(0, 5).join(", ")}.` : "Nothing on the calendar today.");
  if (dueTitles.length) {
    parts.push(`Due: ${dueTitles.join(", ")}${due.length > 4 ? `, +${due.length - 4} more` : ""}.`);
  } else {
    parts.push("Nothing due — clear plate.");
  }
  parts.push("Text me to add or knock anything out.");

  try {
    await sendSms(to, parts.join(" "));
    return NextResponse.json({ ok: true, sent: true });
  } catch (err) {
    console.error("morning send failed", err);
    return NextResponse.json({ ok: false, error: "send failed" }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
