/**
 * Thunder Kittens (her volleyball coaching app) — READ-ONLY. Connects to that
 * app's own Neon database and reads her games, practices, and roster so Scout can
 * answer "when's our next game / who's on snacks / what's our schedule" and drive
 * season reminders from real data. Dormant until VOLLEYBALL_DATABASE_URL is set.
 * Deliberately read-only: no writes to her live coaching app.
 */
import { neon } from "@neondatabase/serverless";

const DB_URL = () => process.env.VOLLEYBALL_DATABASE_URL;
export function volleyballEnabled(): boolean {
  return !!DB_URL();
}

let _sql: ReturnType<typeof neon> | null = null;
function sql() {
  if (!_sql) _sql = neon(DB_URL()!);
  return _sql;
}

export type Game = {
  date: string; time: string | null; opponent: string | null; location: string | null; home: boolean; scrimmage: boolean;
  scorekeeper: string | null; lineJudge: string | null; snackProvider: string | null;
  setsWon: number | null; setsLost: number | null; notes: string | null;
};

const mapGame = (g: Record<string, unknown>): Game => ({
  date: String(g.date ?? ""),
  // forward-compatible: use a time/game_time column if she adds one, else null
  time: (g.time as string) ?? (g.game_time as string) ?? (g.start_time as string) ?? null,
  opponent: (g.opponent as string) ?? null, location: (g.location as string) ?? null, home: !!g.is_home, scrimmage: !!g.is_scrimmage,
  scorekeeper: (g.scorekeeper as string) ?? null, lineJudge: (g.line_judge as string) ?? null, snackProvider: (g.snack_provider as string) ?? null,
  setsWon: (g.sets_won as number) ?? null, setsLost: (g.sets_lost as number) ?? null, notes: (g.general_notes as string) ?? null,
});

/** Games: "upcoming" (>= today, soonest first), "recent" (past, newest first), or "all". */
export async function getGames(scope: "upcoming" | "recent" | "all", today: string, limit = 20): Promise<Game[]> {
  const db = sql();
  const n = Math.min(limit, 40);
  let rows: Record<string, unknown>[];
  if (scope === "recent") rows = (await db`select * from games where date < ${today} order by date desc limit ${n}`) as Record<string, unknown>[];
  else if (scope === "all") rows = (await db`select * from games order by date asc limit ${n}`) as Record<string, unknown>[];
  else rows = (await db`select * from games where date >= ${today} order by date asc limit ${n}`) as Record<string, unknown>[];
  return rows.map(mapGame);
}

// ── Game-day parent-text formatting ─────────────────────────────────────────
/** Parse "09:10" (24h) or "9:10 am" → minutes since midnight. */
function timeToMin(t: string | null): number | null {
  if (!t) return null;
  const m = t.match(/(\d{1,2}):(\d{2})\s*([ap])?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ap = (m[3] || "").toLowerCase();
  if (ap) h = (h % 12) + (ap === "p" ? 12 : 0);
  return h * 60 + parseInt(m[2], 10);
}
function minToClock(mins: number | null): string | null {
  if (mins == null) return null;
  const x = ((mins % 1440) + 1440) % 1440;
  const H = Math.floor(x / 60), M = x % 60;
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return `${h12}:${String(M).padStart(2, "0")} ${H >= 12 ? "PM" : "AM"}`;
}

/** The copy-paste parent text for a game, in her format (opponent + emojis).
 *  Scorekeeper line only for HOME games (matches the app hiding it when away). */
export function formatGameDayText(g: Game): string {
  const startMin = timeToMin(g.time);
  const start = minToClock(startMin);
  const arrive = startMin != null ? minToClock(startMin - 15) : null;
  const lines = [
    "🏐 Happy (almost) game day! 🏐",
    "",
    `🆚 ${g.opponent || "TBD"}${g.home ? " (home)" : " (away)"}`,
    `📍 ${g.location || (g.home ? "Home" : "TBD")}`,
    start ? `🕘 Starts ${start} · arrive by ${arrive}` : "🕘 Starts [add game time]",
    g.lineJudge ? `🚩 Line judge: ${g.lineJudge}` : "🚩 Line judge: still need a volunteer 🙏🏻",
  ];
  if (g.home) lines.push(g.scorekeeper ? `📋 Scorekeeper: ${g.scorekeeper}` : "📋 Scorekeeper: still need a volunteer 🙏🏻");
  lines.push(
    g.snackProvider ? `🍿 Snacks: ${g.snackProvider}` : "🍿 Snacks: still need someone 🙏🏻",
    "",
    "Let me know if you can't make it tomorrow. See you soon! 💜"
  );
  return lines.join("\n");
}

export async function getPractices(today: string, limit = 15): Promise<{ date: string; title: string; minutes: number | null; notes: string | null }[]> {
  const rows = (await sql()`select * from practices where date >= ${today} order by date asc limit ${limit}`) as Record<string, unknown>[];
  return rows.map((p) => ({ date: String(p.date ?? ""), title: (p.title as string) ?? "Practice", minutes: (p.total_minutes as number) ?? null, notes: (p.notes as string) ?? null }));
}

export async function getRoster(): Promise<{ season: string | null; players: { name: string; grade: number | null; number: number | null }[] }> {
  const db = sql();
  const seasons = (await db`select * from seasons where is_active = true limit 1`) as Record<string, unknown>[];
  const season = seasons[0];
  const players = (await db`select id, name, grade, jersey_number from players order by grade, name`) as Record<string, unknown>[];
  let roster = players;
  const ids = season?.roster_player_ids as number[] | undefined;
  if (ids?.length) { const set = new Set(ids); roster = players.filter((p) => set.has(p.id as number)); }
  return {
    season: (season?.name as string) ?? null,
    players: roster.map((p) => ({ name: (p.name as string) ?? "", grade: (p.grade as number) ?? null, number: (p.jersey_number as number) ?? null })),
  };
}
