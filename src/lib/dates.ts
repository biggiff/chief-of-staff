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

/**
 * Parse a date the user/Scout gives for WHEN something happened into an instant.
 * Accepts "YYYY-MM-DD" (interpreted at noon in the user's tz to avoid day-shift)
 * or any Date-parseable string. Returns null if unparseable.
 */
export function parseOccurredAt(input: string | null | undefined): Date | null {
  if (!input) return null;
  const s = input.trim();
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return zonedWallToUtc(`${s}T12:00:00`, appTimeZone());
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
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

  // Date-only strings (DATE columns like briefing_date / checkin_date) are
  // calendar dates, not instants. Format them literally — applying a timezone
  // to "2026-06-07" parses it as UTC midnight and shifts it back a day.
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  // Real instants (Date objects, timestamptz) are tz-converted to the user's zone.
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
