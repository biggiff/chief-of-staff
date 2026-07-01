import { NextRequest, NextResponse } from "next/server";
import { todayStr } from "@/lib/dates";
import { getSetting, setSetting } from "@/lib/operator";
import { notifyOwner } from "@/lib/integrations/notify";
import { getGames, volleyballEnabled, type Game } from "@/lib/integrations/volleyball";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** "9:30 am" → "9:15 am" (game time minus 15). Null if unparseable. */
function minus15(t: string | null): string | null {
  if (!t) return null;
  const m = t.match(/(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  const ap = (m[3] || "").toLowerCase();
  let total = (parseInt(m[1], 10) % 12) * 60 + parseInt(m[2], 10) + (ap.startsWith("p") ? 720 : 0) - 15;
  if (total < 0) total += 1440;
  const H = Math.floor(total / 60), M = total % 60;
  const suffix = H >= 12 ? "pm" : "am";
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return `${h12}:${String(M).padStart(2, "0")} ${suffix}`;
}

/** Build the parent text in her voice/format from a game record. */
function composeParentText(g: Game): string {
  const where = g.location || (g.home ? "Home" : g.opponent || "TBD");
  const arrive = minus15(g.time);
  const lines = [
    "🏐 Happy (almost) game day!",
    "",
    `— ${where}`,
    `— Game starts at ${g.time || "[add game time]"}`,
    `— Arrive by ${arrive || "[15 min before start]"}`,
    g.lineJudge ? `— ${g.lineJudge} is our line judge` : "— We still need a volunteer to be our line judge 🙏🏻",
  ];
  // Scorekeeper is only needed when WE'RE the home team (matches the app's own
  // logic, which hides that section for away games).
  if (g.home) {
    lines.push(g.scorekeeper ? `— ${g.scorekeeper} is keeping score` : "— We still need a volunteer to keep score 🙏🏻");
  }
  lines.push(
    g.snackProvider ? `— ${g.snackProvider} is bringing snacks` : "— We still need someone to bring snacks 🙏🏻",
    "",
    "Let me know if you can't make it tomorrow. See you soon!"
  );
  return lines.join("\n");
}

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
  await notifyOwner(`📋 Game-day text — tomorrow's game${vs}. Copy/paste to your parents:\n\n${composeParentText(game)}${note}`);
  await setSetting("gameday_sent", tomorrow);
  return NextResponse.json({ ok: true, sent: tomorrow, opponent: game.opponent });
}

export const GET = run;
export const POST = run;
