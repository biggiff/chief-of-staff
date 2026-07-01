import { NextRequest, NextResponse } from "next/server";
import { notifyOwner, ownerReachable } from "@/lib/integrations/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Watch = { id: string; desc: string; query: string; seenIds: string[]; createdMs: number };

/**
 * Email watchlist (cron, every ~15 min). For each active watch she set ("tell me
 * when the email from X arrives"), search Gmail; the moment a NEW matching email
 * lands, alert her and drop the watch (one-shot). Cheap no-op when no watches.
 * CRON_SECRET-authed.
 */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { getSetting, setSetting } = await import("@/lib/operator");
  const watches: Watch[] = JSON.parse((await getSetting("email_watches")) || "[]");
  if (!watches.length) return NextResponse.json({ ok: true, watches: 0 });

  const { gmailConfigured, listEmails } = await import("@/lib/integrations/gmail");
  if (!gmailConfigured() || !(await ownerReachable())) return NextResponse.json({ ok: false, error: "Not reachable." });

  const remaining: Watch[] = [];
  let alerted = 0;
  for (const w of watches) {
    const hits = await listEmails(`${w.query} newer_than:7d`, 10).catch(() => []);
    const fresh = hits.filter((h) => !w.seenIds.includes(h.id));
    if (fresh.length) {
      const m = fresh[0];
      await notifyOwner(
        `📬 The email you were watching for just came in:\n"${m.subject}" — from ${m.from}\n${(m.snippet || "").slice(0, 180)}\n\n(You asked me to watch for: ${w.desc})`
      );
      alerted++; // one-shot — don't re-add this watch
    } else {
      remaining.push(w);
    }
  }
  await setSetting("email_watches", JSON.stringify(remaining));
  return NextResponse.json({ ok: true, alerted, remaining: remaining.length });
}

export const GET = run;
export const POST = run;
