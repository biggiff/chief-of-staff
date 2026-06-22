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

/**
 * The current weekday + date + time in the user's timezone, computed by code so
 * the model never has to derive (and mis-derive) the day of week. Fresh per call.
 * e.g. "Saturday, June 21, 2026, 10:32 PM MST".
 */
export function nowLong(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: appTimeZone(),
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date());
}

/**
 * A date+time stamped WITH its weekday, computed by code so the model never has
 * to derive a day-of-week (which it gets wrong). e.g. "Fri, Jun 26, 2026, 2:00 PM".
 * Use this everywhere a date is shown to Scout or the user.
 */
export function formatWhen(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: appTimeZone(),
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
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
 * Parse a local wall-clock date-time (e.g. "2026-06-10T15:00") in the user's
 * timezone into a UTC instant. Date-only defaults to 9am local. Used for
 * scheduling reminders at the right real-world moment.
 */
export function parseLocalDateTime(input: string | null | undefined): Date | null {
  if (!input) return null;
  const s = input.trim();
  const dt = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (dt) return zonedWallToUtc(`${dt[1]}T${dt[2]}:${dt[3]}:${dt[4] ?? "00"}`, appTimeZone());
  const d = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (d) return zonedWallToUtc(`${d[1]}T09:00:00`, appTimeZone());
  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
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

/** Local wall-clock parts (in the user's tz) for an instant. */
function localParts(d: Date): { y: number; mo: number; da: number; h: number; mi: number; s: number; weekday: number } {
  const tz = appTimeZone();
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let h = parseInt(get("hour"), 10);
  if (h === 24) h = 0; // hour12:false can emit "24" at midnight
  return { y: +get("year"), mo: +get("month"), da: +get("day"), h, mi: +get("minute"), s: +get("second"), weekday: wdMap[get("weekday")] ?? 0 };
}

/**
 * Next fire time for a recurring reminder, preserving the local wall-clock time
 * and skipping forward until it's in the future. Timezone-safe.
 */
export function nextOccurrence(from: Date, recurrence: "daily" | "weekdays" | "weekly" | "monthly"): Date {
  const DAY = 86_400_000;
  const now = Date.now();
  let next = from.getTime();
  const isWeekend = (t: number) => { const wd = localParts(new Date(t)).weekday; return wd === 0 || wd === 6; };
  let guard = 0;
  do {
    if (recurrence === "weekly") next += 7 * DAY;
    else if (recurrence === "monthly") {
      const p = localParts(new Date(next));
      let mo = p.mo + 1, y = p.y;
      if (mo > 12) { mo = 1; y += 1; }
      const pad = (n: number) => String(n).padStart(2, "0");
      next = zonedWallToUtc(`${y}-${pad(mo)}-${pad(p.da)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`, appTimeZone()).getTime();
    } else if (recurrence === "weekdays") {
      do { next += DAY; } while (isWeekend(next));
    } else {
      next += DAY; // daily
    }
  } while (next <= now && guard++ < 1000);
  return new Date(next);
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
