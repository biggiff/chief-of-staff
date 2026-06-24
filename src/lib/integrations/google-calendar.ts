/**
 * Google Calendar integration (read-only).
 *
 * Single-user OAuth: a one-time consent (see scripts/google-auth.ts) produces a
 * long-lived refresh token stored in env. At request time we exchange it for a
 * short-lived access token and read today's events. No data is written back to
 * Google. Events feed the AI's time-pressure awareness for the daily briefing.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3";

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function calendarEnabled(): boolean {
  return googleConfigured() && !!process.env.GOOGLE_REFRESH_TOKEN;
}

/** Health probe: can we still exchange the refresh token? false = needs reconnecting. */
export async function calendarAuthOk(): Promise<boolean> {
  if (!calendarEnabled()) return true; // not configured ≠ broken
  try {
    await getAccessToken();
    return true;
  } catch {
    return false;
  }
}

async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Google token exchange ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

import { appTimeZone, startEndOfToday, formatTime } from "../dates";

export type CalEvent = {
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  calendar: string; // which calendar it came from
  isPrimary: boolean;
};

export type CalendarInfo = { id: string; name: string; primary: boolean };

type GoogleEvent = {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

/** Every calendar on the connected account — primary plus subscribed/shared. */
export async function listCalendars(): Promise<CalendarInfo[]> {
  if (!calendarEnabled()) return [];
  const token = await getAccessToken();
  const cals: CalendarInfo[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${CAL_API}/users/me/calendarList`);
    url.searchParams.set("minAccessRole", "reader"); // anything we can read
    url.searchParams.set("showHidden", "true"); // include hidden subscribed calendars
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Google calendarList ${res.status}: ${t.slice(0, 200)}`);
    }
    const j = (await res.json()) as {
      items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[];
      nextPageToken?: string;
    };
    for (const c of j.items ?? []) {
      cals.push({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary });
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
  return cals;
}

async function fetchEventsForCalendar(token: string, cal: CalendarInfo, start: Date, end: Date): Promise<CalEvent[]> {
  const url = new URL(`${CAL_API}/calendars/${encodeURIComponent(cal.id)}/events`);
  url.searchParams.set("timeMin", start.toISOString());
  url.searchParams.set("timeMax", end.toISOString());
  url.searchParams.set("timeZone", appTimeZone());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) {
    // Don't let one inaccessible calendar break the whole day — skip it.
    console.error(`calendar "${cal.name}" events ${res.status}`);
    return [];
  }
  const j = (await res.json()) as { items?: GoogleEvent[] };
  return (j.items ?? []).map((e) => ({
    title: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || null,
    allDay: !e.start?.dateTime,
    calendar: cal.name,
    isPrimary: cal.primary,
  }));
}

/** Events across ALL connected calendars within an arbitrary range, merged. */
export async function listEventsBetween(start: Date, end: Date): Promise<CalEvent[]> {
  if (!calendarEnabled()) return [];
  const token = await getAccessToken();
  const cals = await listCalendars();
  const targets = cals.length ? cals : [{ id: "primary", name: "Calendar", primary: true }];
  const perCal = await Promise.all(targets.map((c) => fetchEventsForCalendar(token, c, start, end)));
  const merged = perCal.flat();
  merged.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return merged;
}

/** Today's events across ALL connected calendars (primary + subscribed), merged. */
export async function listTodaysEvents(): Promise<CalEvent[]> {
  const { start, end } = startEndOfToday();
  return listEventsBetween(start, end);
}

/** One-line-per-event summary for the AI context / tool result. Non-primary
 *  calendars are labeled so Scout can tell where each event lives. */
export function formatEvents(events: CalEvent[]): string {
  if (events.length === 0) return "No events on any calendar today.";
  return events
    .map((e) => {
      const label = e.isPrimary ? "" : ` — [${e.calendar}]`;
      if (e.allDay) return `- (all day) ${e.title}${label}`;
      return `- ${formatTime(e.start)} ${e.title}${label}`;
    })
    .join("\n");
}

/** Resolve a calendar by fuzzy name (exact, then contains; case-insensitive). */
export async function findCalendar(name: string): Promise<CalendarInfo | null> {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const cals = await listCalendars();
  return (
    cals.find((c) => c.name.toLowerCase() === q) ??
    cals.find((c) => c.name.toLowerCase().includes(q)) ??
    null
  );
}

export type NewEvent = {
  title: string;
  date: string; // YYYY-MM-DD (user's tz)
  startTime?: string | null; // "HH:MM" 24h; omit/null = all-day
  endTime?: string | null; // "HH:MM"; defaults to start + 1h
  calendarName?: string | null; // fuzzy match; defaults to primary
  location?: string | null;
  description?: string | null;
};

export type CreateResult =
  | { ok: true; title: string; calendar: string; when: string; htmlLink: string | null }
  | { ok: false; error: string; calendars?: string[]; needsReconnect?: boolean };

const pad = (t: string): string => {
  const [h, m] = t.trim().split(":");
  return `${String(parseInt(h, 10)).padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}`;
};
const addHour = (t: string): string => {
  const [h, m] = pad(t).split(":").map((n) => parseInt(n, 10));
  return `${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
const nextDay = (ymd: string): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Create a real event on a chosen calendar. Requires calendar write scope. */
export async function createEvent(ev: NewEvent): Promise<CreateResult> {
  if (!calendarEnabled()) return { ok: false, error: "Calendar isn't connected." };
  const token = await getAccessToken();

  let cal: CalendarInfo | null;
  if (ev.calendarName && ev.calendarName.trim()) {
    cal = await findCalendar(ev.calendarName);
    if (!cal) {
      const cals = await listCalendars();
      return { ok: false, error: `No calendar matches "${ev.calendarName}".`, calendars: cals.map((c) => c.name) };
    }
  } else {
    const cals = await listCalendars();
    cal = cals.find((c) => c.primary) ?? { id: "primary", name: "Calendar", primary: true };
  }

  const tz = appTimeZone();
  const body: Record<string, unknown> = {
    summary: ev.title,
    ...(ev.location ? { location: ev.location } : {}),
    ...(ev.description ? { description: ev.description } : {}),
  };
  if (ev.startTime) {
    const end = ev.endTime || addHour(ev.startTime);
    body.start = { dateTime: `${ev.date}T${pad(ev.startTime)}:00`, timeZone: tz };
    body.end = { dateTime: `${ev.date}T${pad(end)}:00`, timeZone: tz };
  } else {
    body.start = { date: ev.date }; // all-day; end date is exclusive
    body.end = { date: nextDay(ev.date) };
  }

  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(cal.id)}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        needsReconnect: true,
        error: `Calendar is connected READ-ONLY — I can't create events until Google is reconnected with calendar write access. (Google ${res.status})`,
      };
    }
    return { ok: false, error: `Google create event ${res.status}: ${t.slice(0, 150)}` };
  }
  const j = (await res.json()) as { htmlLink?: string };
  const when = ev.startTime ? `${ev.date} at ${pad(ev.startTime)}` : `${ev.date} (all day)`;
  return { ok: true, title: ev.title, calendar: cal.name, when, htmlLink: j.htmlLink ?? null };
}
