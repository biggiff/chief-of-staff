import { NextRequest, NextResponse } from "next/server";
import { dueReminders, markReminderSent } from "@/lib/operator";
import { notifyOwner } from "@/lib/integrations/notify";

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
    const res = await notifyOwner(`⏰ ${r.text}`);
    if (res.ok) {
      await markReminderSent(r.id);
      sent++;
    } else {
      console.error("reminder send failed", r.id, res.error);
    }
  }
  return NextResponse.json({ ok: true, due: due.length, sent });
}

export const GET = run;
export const POST = run;
