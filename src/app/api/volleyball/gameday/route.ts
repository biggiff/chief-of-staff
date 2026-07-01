import { NextRequest, NextResponse } from "next/server";
import { todayStr } from "@/lib/dates";
import { getSetting, setSetting } from "@/lib/operator";
import { notifyOwner } from "@/lib/integrations/notify";
import { getGames, formatGameDayText, volleyballEnabled } from "@/lib/integrations/volleyball";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Daily (cron). If a REAL game (not a scrimmage) is TOMORROW, send her a
 * copy-paste-ready parent text pulled from her volleyball app. Once per game.
 */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!volleyballEnabled()) return NextResponse.json({ ok: false, error: "Volleyball app not connected." });

  const today = todayStr();
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const games = await getGames("upcoming", today, 15).catch(() => []);
  const game = games.find((g) => g.date.slice(0, 10) === tomorrow && !g.scrimmage);
  if (!game) return NextResponse.json({ ok: true, skipped: "no real game tomorrow" });

  if ((await getSetting("gameday_sent")) === tomorrow) return NextResponse.json({ ok: true, alreadySent: tomorrow });

  const vs = game.opponent ? ` vs ${game.opponent}` : "";
  const note = game.time ? "" : "\n\n(Add a game time in your app and I'll fill in the start/arrival times automatically next time.)";
  await notifyOwner(`📋 Game-day text — tomorrow's game${vs}. Copy/paste to your parents:\n\n${formatGameDayText(game)}${note}`);
  await setSetting("gameday_sent", tomorrow);
  return NextResponse.json({ ok: true, sent: tomorrow, opponent: game.opponent });
}

export const GET = run;
export const POST = run;
