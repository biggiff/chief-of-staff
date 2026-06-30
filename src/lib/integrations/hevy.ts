/**
 * Hevy integration (read-only). Pulls logged workouts (and routines) so Scout can
 * answer "what did I lift", "how was my last session", "what's my training been
 * this week" from real data. Auth: `api-key` header (Hevy Pro). Dormant until
 * HEVY_API_KEY is set.
 */
const API = "https://api.hevyapp.com/v1";
const KEY = () => process.env.HEVY_API_KEY;

export function hevyEnabled(): boolean {
  return !!KEY();
}

type HevySet = { type?: string; weight_kg?: number | null; reps?: number | null; distance_meters?: number | null; duration_seconds?: number | null };
type HevyExercise = { title?: string; sets?: HevySet[] };
type HevyWorkout = { title?: string; start_time?: string; exercises?: HevyExercise[] };

const lb = (kg?: number | null) => (kg == null ? null : Math.round(kg * 2.20462));

/** Recent logged workouts, with per-exercise sets (weight in lb + reps). */
export async function getRecentWorkouts(count = 10): Promise<
  { title: string; date: string; exercises: { name: string; sets: { weight_lb: number | null; reps: number | null }[] }[] }[]
> {
  if (!hevyEnabled()) return [];
  const res = await fetch(`${API}/workouts?page=1&pageSize=${Math.min(count, 10)}`, {
    headers: { "api-key": KEY()! },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Hevy workouts ${res.status}`);
  const j = (await res.json()) as { workouts?: HevyWorkout[] };
  return (j.workouts ?? []).map((w) => ({
    title: w.title || "Workout",
    date: (w.start_time || "").slice(0, 10),
    exercises: (w.exercises ?? []).map((e) => ({
      name: e.title || "Exercise",
      sets: (e.sets ?? [])
        .filter((s) => s.type !== "warmup")
        .map((s) => ({ weight_lb: lb(s.weight_kg), reps: s.reps ?? null })),
    })),
  }));
}

/** Consistency stats for the accountability nudge. `todayYmd` is YYYY-MM-DD in
 *  her timezone (passed in to keep this module date-lib-free). */
export async function getWorkoutStats(todayYmd: string): Promise<{ lastDate: string | null; daysSince: number | null; last7: number }> {
  const ws = await getRecentWorkouts(10).catch(() => []);
  const dates = ws.map((w) => w.date).filter(Boolean).sort(); // ascending YYYY-MM-DD
  if (!dates.length) return { lastDate: null, daysSince: null, last7: 0 };
  const todayMs = Date.parse(`${todayYmd}T00:00:00Z`);
  const lastDate = dates[dates.length - 1];
  const daysSince = Math.round((todayMs - Date.parse(`${lastDate}T00:00:00Z`)) / 86_400_000);
  const weekAgo = todayMs - 7 * 86_400_000;
  const last7 = dates.filter((d) => Date.parse(`${d}T00:00:00Z`) >= weekAgo).length;
  return { lastDate, daysSince, last7 };
}

/** Saved routines (names + exercises) — what she's planning to train. */
export async function getRoutines(): Promise<{ title: string; exercises: string[] }[]> {
  if (!hevyEnabled()) return [];
  const res = await fetch(`${API}/routines?page=1&pageSize=10`, { headers: { "api-key": KEY()! }, cache: "no-store" });
  if (!res.ok) throw new Error(`Hevy routines ${res.status}`);
  const j = (await res.json()) as { routines?: { title?: string; exercises?: { title?: string }[] }[] };
  return (j.routines ?? []).map((r) => ({ title: r.title || "Routine", exercises: (r.exercises ?? []).map((e) => e.title || "") }));
}
