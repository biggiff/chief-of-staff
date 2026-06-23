/**
 * Oura Ring integration (read-only). A personal access token (long-lived) pulls
 * sleep, readiness, and activity so Scout can ground the Health picture in real
 * body data instead of guessing. Dormant until OURA_ACCESS_TOKEN is set.
 */
import { appTimeZone } from "../dates";

const API = "https://api.ouraring.com/v2/usercollection";
const TOKEN = () => process.env.OURA_ACCESS_TOKEN;

export function ouraEnabled(): boolean {
  return !!TOKEN();
}

/** YYYY-MM-DD in the user's timezone, offset by `daysAgo`. */
function ymd(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: appTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function fetchCollection(ep: string, start: string, end: string): Promise<Record<string, unknown>[]> {
  const url = `${API}/${ep}?start_date=${start}&end_date=${end}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN()}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Oura ${ep} ${res.status}`);
  const j = (await res.json()) as { data?: Record<string, unknown>[] };
  return j.data ?? [];
}

/** Today's step count so far (updates intraday as the ring syncs). */
export async function getTodaySteps(): Promise<number | null> {
  if (!ouraEnabled()) return null;
  const today = ymd(0);
  const rows = await fetchCollection("daily_activity", today, today).catch(() => []);
  const todayRow = rows.find((r) => String(r.day) === today) ?? rows[rows.length - 1];
  return todayRow ? ((todayRow.steps as number) ?? null) : null;
}

export type OuraDay = { date: string; readiness: number | null; sleep: number | null; sleepHours: number | null; activity: number | null; steps: number | null };

/** Recent sleep/readiness/activity, merged by day (newest last). */
export async function getOuraData(days = 7): Promise<{ latest: OuraDay | null; trend: OuraDay[] } | null> {
  if (!ouraEnabled()) return null;
  const start = ymd(days);
  const end = ymd(0);
  const [readiness, sleepScore, activity, sleepSessions] = await Promise.all([
    fetchCollection("daily_readiness", start, end).catch(() => []),
    fetchCollection("daily_sleep", start, end).catch(() => []),
    fetchCollection("daily_activity", start, end).catch(() => []),
    fetchCollection("sleep", start, end).catch(() => []),
  ]);

  const byDay = new Map<string, OuraDay>();
  const ensure = (day: string) => {
    if (!byDay.has(day)) byDay.set(day, { date: day, readiness: null, sleep: null, sleepHours: null, activity: null, steps: null });
    return byDay.get(day)!;
  };
  for (const r of readiness) ensure(String(r.day)).readiness = (r.score as number) ?? null;
  for (const s of sleepScore) ensure(String(s.day)).sleep = (s.score as number) ?? null;
  for (const a of activity) {
    const d = ensure(String(a.day));
    d.activity = (a.score as number) ?? null;
    d.steps = (a.steps as number) ?? null;
  }
  // Longest sleep session per day → hours.
  for (const s of sleepSessions) {
    const secs = (s.total_sleep_duration as number) ?? 0;
    const d = ensure(String(s.day));
    const hours = Math.round((secs / 3600) * 10) / 10;
    if (d.sleepHours == null || hours > d.sleepHours) d.sleepHours = hours;
  }

  const trend = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { latest: trend[trend.length - 1] ?? null, trend };
}
