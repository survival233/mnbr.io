/**
 * Microsoft Outlook / Office 365 calendar via Graph API.
 * Same idea as Google: the traveler connects their Microsoft account once;
 * sync works from any device.
 *
 * Auth: OAuth2 access token with Calendars.Read.
 */
import type { CalendarEventInput } from "./parse-flight-event.js";

export interface FetchOutlookEventsArgs {
  accessToken: string;
  /** Default: /me/calendar/calendarView. */
  timeMin?: Date;
  timeMax?: Date;
  maxResults?: number;
}

export async function fetchOutlookCalendarEvents(args: FetchOutlookEventsArgs): Promise<CalendarEventInput[]> {
  const timeMin = (args.timeMin ?? new Date(Date.now() - 30 * 86400_000)).toISOString();
  const timeMax = (args.timeMax ?? new Date(Date.now() + 180 * 86400_000)).toISOString();
  const top = args.maxResults ?? 100;

  const url =
    `https://graph.microsoft.com/v1.0/me/calendarView` +
    `?startDateTime=${encodeURIComponent(timeMin)}` +
    `&endDateTime=${encodeURIComponent(timeMax)}` +
    `&$top=${top}` +
    `&$orderby=start/dateTime` +
    `&$select=id,subject,location,bodyPreview,start,end`;

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!res.ok) {
    throw new Error(`Microsoft Graph ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    value?: Array<{
      id: string;
      subject?: string;
      location?: { displayName?: string };
      bodyPreview?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
    }>;
  };

  return (data.value ?? [])
    .filter((ev) => ev.start?.dateTime)
    .map((ev) => ({
      externalEventId: `outlook:${ev.id}`,
      title: ev.subject ?? null,
      location: ev.location?.displayName ?? null,
      description: ev.bodyPreview ? ev.bodyPreview.slice(0, 500) : null,
      startsAt: ev.start!.dateTime!,
      endsAt: ev.end?.dateTime ?? null,
      provider: "outlook" as const,
    }));
}
