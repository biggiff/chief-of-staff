/**
 * Timezone-aware date helpers.
 *
 * The server runs in UTC (Vercel), so "today" and time-of-day must be computed
 * in the user's zone, not the server's. The zone comes from APP_TZ (an IANA
 * name like "America/Denver"); falls back to UTC if unset.
 */

export function appTimeZone(): string {
  return process.env.APP_TZ || "UTC";
}

/** Today's date as YYYY-MM-DD in the user's timezone. */
export function todayStr(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: appTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Offset (ms) of a timezone at a given instant: localWallClock − utcWallClock. */
function tzOffsetMs(date: Date, tz: string): number {
  const local = new Date(date.toLocaleString("en-US", { timeZone: tz }));
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}

/** Convert a wall-clock "YYYY-MM-DDTHH:mm:ss" in the user's tz to a UTC instant. */
function zonedWallToUtc(wall: string, tz: string): Date {
  const asUtc = new Date(`${wall}Z`);
  return new Date(asUtc.getTime() - tzOffsetMs(asUtc, tz));
}

/** Start/end instants of "today" in the user's timezone. */
export function startEndOfToday(): { start: Date; end: Date } {
  const tz = appTimeZone();
  const day = todayStr();
  return {
    start: zonedWallToUtc(`${day}T00:00:00`, tz),
    end: zonedWallToUtc(`${day}T23:59:59`, tz),
  };
}

export function daysSince(date: Date | null | undefined): number | null {
  if (!date) return null;
  const ms = Date.now() - new Date(date).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    timeZone: appTimeZone(),
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-US", {
    timeZone: appTimeZone(),
    hour: "numeric",
    minute: "2-digit",
  });
}
