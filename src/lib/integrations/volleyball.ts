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
