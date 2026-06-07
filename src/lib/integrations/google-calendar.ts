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

export type CalEvent = { title: string; start: string; end: string | null; allDay: boolean };

type GoogleEvent = {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

/** Today's events from the primary calendar, in the user's timezone. */
export async function listTodaysEvents(): Promise<CalEvent[]> {
  if (!calendarEnabled()) return [];
  const token = await getAccessToken();

  const { start, end } = startEndOfToday();

  const url = new URL(`${CAL_API}/calendars/primary/events`);
  url.searchParams.set("timeMin", start.toISOString());
  url.searchParams.set("timeMax", end.toISOString());
  url.searchParams.set("timeZone", appTimeZone());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Google Calendar ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { items?: GoogleEvent[] };
  return (j.items ?? []).map((e) => ({
    title: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || null,
    allDay: !e.start?.dateTime,
  }));
}

/** One-line-per-event summary for the AI context / tool result. */
export function formatEvents(events: CalEvent[]): string {
  if (events.length === 0) return "No events on the calendar today.";
  return events
    .map((e) => {
      if (e.allDay) return `- (all day) ${e.title}`;
      return `- ${formatTime(e.start)} ${e.title}`;
    })
    .join("\n");
}
