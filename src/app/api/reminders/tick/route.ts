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
    // Firm-but-kind escalation: first check-back is gentle; repeats get firmer and
    // ask what's blocking — always with the same easy 4-option exit.
    const opts = `Reply "done", "not yet", "too big", or "drop it".`;
    let body: string;
    if (!isCheckBack) {
      body = `⏰ ${r.text}`;
    } else if (r.followUpsLeft >= 2) {
      body = `Did you get to "${r.text}"? ${opts}`;
    } else {
      body = `Still open: "${r.text}". What's blocking it? ${opts} ("too big" → I'll shrink it to a 2-minute start; "drop it" → I'll let it go, no guilt.)`;
    }
    // Surface the saved context (link/address/notes) so it arrives actionable.
    if (r.details) body += `\n${r.details}`;
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
