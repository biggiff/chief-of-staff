import { NextRequest, NextResponse } from "next/server";
import { todayStr } from "@/lib/dates";
import { getSetting, setSetting } from "@/lib/operator";
import { notifyOwner } from "@/lib/integrations/notify";
import { getGames, getPractices, getActiveSeasonName, volleyballEnabled } from "@/lib/integrations/volleyball";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Daily (cron) volleyball season helper — two season-aware nudges:
 *  1) Sign-up link: once per season, when real games (opponent set) are in the
 *     app, remind her to send parents her app's sign-up form link.
 *  2) Practice plan: on Wednesdays in-season, remind her to finalize Thursday's
 *     plan and send it to her assistant coaches.
 * CRON_SECRET-authed. Silent off-season / when already handled.
 */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!volleyballEnabled()) return NextResponse.json({ ok: false, error: "Volleyball app not connected." });

  const season = await getActiveSeasonName();
  if (!season) return NextResponse.json({ ok: true, skipped: "no active season" });

  const today = todayStr();
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const games = await getGames("upcoming", today, 25).catch(() => []);
  const realGames = games.filter((g) => !g.scrimmage);
  const practices = await getPractices(today, 10).catch(() => []);
  const out: Record<string, unknown> = { season };

  // 1) Sign-up link — once per season, once the schedule (real games w/ opponents)
  //    is in the app, nudge her to SEND the app's sign-up form link to parents.
  const scheduled = realGames.filter((g) => g.opponent && g.opponent.trim() && !/^tbd$/i.test(g.opponent));
  if (scheduled.length && (await getSetting(`sug_${season}`)) !== "done") {
    const first = scheduled[0];
    await notifyOwner(
      `🏐 Your ${season} game schedule is up — ${scheduled.length} game${scheduled.length === 1 ? "" : "s"} (first: ${first.date} vs ${first.opponent}). Time to send parents your sign-up link so they can claim snacks, line judge, and scorekeeper. Reply "done" once it's sent, or "not yet" and I'll follow up.`
    );
    await setSetting(`sug_${season}`, "done");
    out.signupLink = true;
  }

  // 2) Practice plan — the DAY BEFORE an actual practice (from the app), remind her
  //    to finalize the plan + send it to her assistant coaches. Only fires when a
  //    real practice is on the calendar tomorrow (not every week all off-season).
  const practiceTomorrow = practices.find((p) => p.date.slice(0, 10) === tomorrow);
  if (practiceTomorrow && (await getSetting("practiceplan_last")) !== tomorrow) {
    await notifyOwner(
      `🏐 Practice tomorrow — "${practiceTomorrow.title}". Have the plan finalized today and sent to your assistant coaches. Reply "done" when it's out, or "not yet" and I'll follow up.`
    );
    await setSetting("practiceplan_last", tomorrow);
    out.practicePlan = true;
  }

  return NextResponse.json({ ok: true, ...out });
}

export const GET = run;
export const POST = run;
