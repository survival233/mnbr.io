/**
 * Google Calendar — works on any device (iOS, Android, web, desktop).
 * The traveler connects their Google account once; we pull flight events from
 * that account regardless of which phone or browser they use.
 *
 * Auth: OAuth2 access token with calendar.readonly (or calendar.events.readonly).
 * We only map title/location/start/end — never store email bodies.
 */
import type { CalendarEventInput } from "./parse-flight-event.js";

export interface GoogleCalendarListItem {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
}

export interface FetchGoogleEventsArgs {
  accessToken: string;
  /** Calendar ids to read. Default: ["primary"]. Pass "all" to list writable calendars. */
  calendarIds?: string[] | "all";
  /** Inclusive window. Defaults to 30 days past → 180 days ahead. */
  timeMin?: Date;
  timeMax?: Date;
  maxResultsPerCalendar?: number;
}

async function gcalFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`Google Calendar API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function listGoogleCalendars(accessToken: string): Promise<GoogleCalendarListItem[]> {
  const data = await gcalFetch<{ items?: GoogleCalendarListItem[] }>(
    accessToken,
    "/users/me/calendarList?minAccessRole=reader&maxResults=50",
  );
  return data.items ?? [];
}

/** Fetch events from one or more Google calendars as CalendarEventInput[]. */
export async function fetchGoogleCalendarEvents(args: FetchGoogleEventsArgs): Promise<CalendarEventInput[]> {
  const timeMin = (args.timeMin ?? new Date(Date.now() - 30 * 86400_000)).toISOString();
  const timeMax = (args.timeMax ?? new Date(Date.now() + 180 * 86400_000)).toISOString();
  const max = args.maxResultsPerCalendar ?? 50;

  let calendarIds: string[];
  if (args.calendarIds === "all") {
    const list = await listGoogleCalendars(args.accessToken);
    calendarIds = list.map((c) => c.id);
    if (calendarIds.length === 0) calendarIds = ["primary"];
  } else {
    calendarIds = args.calendarIds ?? ["primary"];
  }

  const out: CalendarEventInput[] = [];
  for (const calId of calendarIds) {
    const q = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(max),
    });
    const data = await gcalFetch<{
      items?: Array<{
        id: string;
        summary?: string;
        location?: string;
        description?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }>;
    }>(args.accessToken, `/calendars/${encodeURIComponent(calId)}/events?${q}`);

    for (const ev of data.items ?? []) {
      const startsAt = ev.start?.dateTime ?? ev.start?.date;
      if (!startsAt) continue;
      out.push({
        externalEventId: `google:${calId}:${ev.id}`,
        title: ev.summary ?? null,
        location: ev.location ?? null,
        // Cap description — parsers only need the first lines for route clues
        description: ev.description ? ev.description.slice(0, 500) : null,
        startsAt,
        endsAt: ev.end?.dateTime ?? ev.end?.date ?? null,
        provider: "google",
      });
    }
  }
  return out;
}
