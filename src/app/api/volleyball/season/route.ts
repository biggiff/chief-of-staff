import { NextRequest, NextResponse } from "next/server";
import { todayStr } from "@/lib/dates";
import { getSetting, setSetting } from "@/lib/operator";
import { notifyOwner } from "@/lib/integrations/notify";
import { getGames, getPractices, getActiveSeasonName, volleyballEnabled } from "@/lib/integrations/volleyball";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Daily (cron) volleyball season helper — two season-aware nudges:
 *  1) SignUpGenius: once per season, when real games (opponent set) are in the
 *     app, remind her to create/update the SignUpGenius.
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
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 Sun … 3 Wed
  const games = await getGames("upcoming", today, 25).catch(() => []);
  const realGames = games.filter((g) => !g.scrimmage);
  const practices = await getPractices(today, 10).catch(() => []);
  const out: Record<string, unknown> = { season };

  // 1) SignUpGenius — once per season, once the schedule (real games w/ opponents) is in.
  const scheduled = realGames.filter((g) => g.opponent && g.opponent.trim() && !/^tbd$/i.test(g.opponent));
  if (scheduled.length && (await getSetting(`sug_${season}`)) !== "done") {
    const first = scheduled[0];
    await notifyOwner(
      `🏐 Your ${season} game schedule is up — ${scheduled.length} game${scheduled.length === 1 ? "" : "s"} (first: ${first.date} vs ${first.opponent}). Time to create/update your SignUpGenius so parents can claim snacks, line judge, and scorekeeper. Want me to set a reminder to follow up if it's not done?`
    );
    await setSetting(`sug_${season}`, "done");
    out.signupGenius = true;
  }

  // 2) Practice plan — Wednesdays, in-season (a practice or real game is on the horizon).
  const inSeason = practices.length > 0 || realGames.length > 0;
  if (weekday === 3 && inSeason && (await getSetting("practiceplan_last")) !== today) {
    await notifyOwner(
      `🏐 Practice-plan check: have Thursday's plan finalized (aim for today) and sent to your assistant coaches. Reply "done" when it's out — or "not yet" and I'll follow up.`
    );
    await setSetting("practiceplan_last", today);
    out.practicePlan = true;
  }

  return NextResponse.json({ ok: true, ...out });
}

export const GET = run;
export const POST = run;
