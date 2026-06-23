import { NextRequest, NextResponse } from "next/server";
import { dueReminders, markReminderSent, rearmReminder, enterFollowUp, recordCheckBack } from "@/lib/operator";
import { notifyOwner } from "@/lib/integrations/notify";
import { nextOccurrence } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Fires every minute (cron). Sends any reminders that have come due to the owner
 * via their channel (Telegram), then marks them sent. CRON_SECRET-authed; Vercel
 * injects the bearer for its own cron invocations.
 */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const due = await dueReminders();
  let sent = 0;
  for (const r of due) {
    const nextCheck = r.followUpAfterMinutes ? new Date(Date.now() + r.followUpAfterMinutes * 60_000) : null;
    const isCheckBack = !r.recurrence && r.followUpAfterMinutes && r.awaitingConfirm;
    // A check-back is a question with an easy exit; the first fire is the nudge.
    const body = isCheckBack
      ? `Did you get to "${r.text}"? Reply "done", "not yet", or "drop it" and I'll stop asking.`
      : `⏰ ${r.text}`;
    const res = await notifyOwner(body);
    if (!res.ok) { console.error("reminder send failed", r.id, res.error); continue; }
    sent++;

    if (r.recurrence) {
      await rearmReminder(r.id, nextOccurrence(r.remindAt, r.recurrence));
    } else if (r.followUpAfterMinutes && nextCheck) {
      if (!r.awaitingConfirm) {
        // First check-back: use the absolute time if set & still future, else relative.
        const firstCheck = r.followUpFirstAt && r.followUpFirstAt.getTime() > Date.now() ? r.followUpFirstAt : nextCheck;
        await enterFollowUp(r.id, firstCheck);
      } else {
        await recordCheckBack(r.id, r.followUpsLeft, nextCheck); // 2nd check → +interval (default +24h) / slip
      }
    } else {
      await markReminderSent(r.id);
    }
  }
  return NextResponse.json({ ok: true, due: due.length, sent });
}

export const GET = run;
export const POST = run;
