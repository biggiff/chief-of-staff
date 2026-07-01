import { NextRequest, NextResponse } from "next/server";
import { todayStr } from "@/lib/dates";
import { getSetting, setSetting, createReminder } from "@/lib/operator";
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

  // Season-timing anchors used by the nudges below.
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const firstPractice = practices[0]; // earliest upcoming practice
  const daysToPractice = firstPractice
    ? (Date.parse(`${firstPractice.date.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
    : Infinity;
  const firstGame = realGames[0]; // earliest real (non-scrimmage) game
  const daysToFirstGame = firstGame
    ? (Date.parse(`${firstGame.date.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
    : Infinity;

  // 1) Sign-up link — on the SUNDAY BEFORE the first game (when the schedule usually
  //    drops). Create ONE firm-but-kind commitment to send parents the season sign-up
  //    link once her schedule is complete. Accountability loop handles done/not-yet.
  if (firstGame && weekday === 0 && daysToFirstGame >= 1 && daysToFirstGame <= 7 && (await getSetting(`sug_${season}`)) !== "created") {
    const link = (await getSetting("volleyball_signup_link"))?.trim();
    // Verify the link actually loads before handing it over — a dead link is worse
    // than no link.
    let linkPart = "";
    if (link) {
      const { checkSignupLink } = await import("@/lib/integrations/volleyball");
      const chk = await checkSignupLink(link);
      linkPart = chk.ok ? ` (${link})` : ` — ⚠️ your saved link isn't loading right now, double-check it: ${link}`;
    }
    const text = `Send parents the ${season} sign-up link${linkPart} once your schedule is complete — for snacks, line judge & scorekeeper.`;
    await createReminder({ text, remindAt: new Date(), followUpAfterMinutes: 1440 });
    await setSetting(`sug_${season}`, "created");
    out.signupCommitment = true;
  }

  // 1b) Parent info sheet — BEFORE the first practice, nudge to update + send it.
  //     Easy to skip when parents are mostly returning. Once per season.
  if (firstPractice && daysToPractice <= 3 && (await getSetting(`infosheet_${season}`)) !== "created") {
    await createReminder({
      text: `Update + send your parent info sheet before the first practice — for snacks, line judge & scorekeeper. Reply "done" when it's out, or "drop it" to skip this season (fine if your parents are mostly returning).`,
      remindAt: new Date(),
      followUpAfterMinutes: 1440,
    });
    await setSetting(`infosheet_${season}`, "created");
    out.infoSheet = true;
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

  // 3) Next-season kickoff — once, AFTER the first real game, a firm-but-kind
  //    commitment to start the next-season conversation with parents (early
  //    registration saves money). The accountability loop keeps it alive until done.
  if (firstGame && today > firstGame.date.slice(0, 10) && (await getSetting(`nextseason_${season}`)) !== "created") {
    await createReminder({
      text: `Start talking with parents about NEXT season — early registration saves money, so the sooner you kick it off the better. Games are a good moment (they're all there).`,
      remindAt: new Date(),
      followUpAfterMinutes: 1440,
    });
    await setSetting(`nextseason_${season}`, "created");
    out.nextSeason = true;
  }

  return NextResponse.json({ ok: true, ...out });
}

export const GET = run;
export const POST = run;
