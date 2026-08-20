/**
 * Calendar event → minimized trip fields.
 *
 * Input is the common shape every cloud calendar exposes (Google, Outlook,
 * Apple/iCloud, ICS): title, location, description, start/end. Works the same
 * whether the traveler connected from iOS, Android, web, or desktop — we read
 * the account, not the phone OS.
 *
 * Output never includes flight number, PNR, seat, or passenger name.
 * Pure: no I/O, exhaustively testable.
 */
import { inferDirection, normalizeCity } from "./cities.js";
import type { CalendarProviderName } from "./providers.js";

export interface CalendarEventInput {
  /** Stable id from the calendar provider (google:cal:eventId, etc.). */
  externalEventId: string;
  title?: string | null;
  location?: string | null;
  description?: string | null;
  /** Event start (departure). */
  startsAt: Date | string;
  /** Event end (arrival or return). Optional. */
  endsAt?: Date | string | null;
  provider?: CalendarProviderName;
}

export interface ParsedFlightTrip {
  externalEventId: string;
  provider: CalendarProviderName;
  departureCity: string;
  destinationCity: string;
  departureDate: Date; // local calendar day
  returnDate: Date | null;
  direction: "us_to_gh" | "gh_to_us";
  // Prisma enum leftover; inferDirection accepts any origin→destination pair.
  /** 0–1. Below 0.7 should require traveler confirmation before job alerts. */
  confidence: number;
  /** Human-readable reasons that contributed to the parse. */
  signals: string[];
}

export type ParseResult =
  | { ok: true; trip: ParsedFlightTrip }
  | { ok: false; reason: string };

const FLIGHTISH =
  /\b(flight|fly|flying|depart(?:ure|ing)?|arriv(?:al|ing)?|boarding|itinerary|ticket|airways?|airlines?|delta|united|american|jetblue|emirates|qatar|turkish|ethiopian|egyptair|british airways|klm|lufthansa|air france|tap|brussels)\b/i;

const ROUTE_PATTERNS: RegExp[] = [
  // "JFK → ACC", "New York to Accra", "EWR - ACC"
  /\b([A-Za-z .']{2,40}?)\s*(?:→|->|–|—|-|to|\/)\s*([A-Za-z .']{2,40})\b/i,
  // "Flight to Accra"
  /\b(?:flight|fly(?:ing)?|depart(?:ing)?|arriv(?:ing)?)\s+(?:to|for|into)\s+([A-Za-z .']{2,40})\b/i,
  // "Arrive Accra" / "Arrival: Accra"
  /\barriv(?:e|al|ing)[:\s]+([A-Za-z .']{2,40})\b/i,
];

function asDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Strip to local calendar day (UTC noon avoids TZ day-shift in DB date columns). */
function calendarDay(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12));
}

function extractRoute(blob: string): { from: string | null; to: string | null; signals: string[] } {
  const signals: string[] = [];
  for (const re of ROUTE_PATTERNS) {
    const m = blob.match(re);
    if (!m) continue;
    if (m[2]) {
      signals.push(`route:${m[1].trim()}→${m[2].trim()}`);
      return { from: m[1].trim(), to: m[2].trim(), signals };
    }
    if (m[1]) {
      signals.push(`dest:${m[1].trim()}`);
      return { from: null, to: m[1].trim(), signals };
    }
  }
  return { from: null, to: null, signals };
}

/**
 * Parse one calendar event into a trip, or reject it as not a flight.
 * Past flights are accepted (status set by the caller); matching only uses upcoming.
 */
export function parseFlightEvent(ev: CalendarEventInput, now: Date = new Date()): ParseResult {
  const startsAt = asDate(ev.startsAt);
  if (!startsAt) return { ok: false, reason: "missing_start" };

  const title = (ev.title ?? "").trim();
  const location = (ev.location ?? "").trim();
  const description = (ev.description ?? "").trim();
  // Cap description — never need the full email body if one was pasted in
  const blob = [title, location, description.slice(0, 500)].filter(Boolean).join(" | ");

  if (!blob) return { ok: false, reason: "empty_event" };

  const looksLikeFlight = FLIGHTISH.test(blob) || /\b[A-Z]{2}\s?\d{1,4}\b/.test(blob);
  const route = extractRoute(blob);

  let from: string | null = normalizeCity(route.from);
  let to: string | null = normalizeCity(route.to);

  // "Flight to Accra" matches the X-to-Y pattern with origin "Flight"
  if (route.from && /^(flight|fly|flying|depart(?:ure|ing)?|arriv(?:al|ing)?|boarding)$/i.test(route.from.trim())) {
    from = null;
  }

  // Location field often holds the destination airport alone
  if (!to) {
    const locCity = normalizeCity(location);
    if (locCity) {
      to = locCity;
      route.signals.push(`location:${locCity}`);
    }
  }

  // Title-only destination: "Accra trip" / city name in title
  if (!to) {
    const titleCity = normalizeCity(title);
    if (titleCity) {
      to = titleCity;
      route.signals.push(`title-city:${titleCity}`);
    }
  }

  if (!to) return { ok: false, reason: "no_destination" };

  if (!from) {
    from = "Unknown";
    route.signals.push("origin_unknown");
  }

  if (from === to) return { ok: false, reason: "same_city" };

  const direction = inferDirection(from, to);
  if (!direction) return { ok: false, reason: "same_city" };

  // Confidence: flight keywords + explicit route > weak title city
  let confidence = 0.45;
  if (looksLikeFlight) confidence += 0.25;
  if (route.from && route.to) confidence += 0.25;
  else if (route.to) confidence += 0.1;
  if (normalizeCity(location)) confidence += 0.05;
  confidence = Math.min(1, Math.round(confidence * 100) / 100);

  // Reject obvious non-flights unless confidence is already high from a route
  if (!looksLikeFlight && confidence < 0.7) {
    return { ok: false, reason: "not_a_flight" };
  }

  const endsAt = asDate(ev.endsAt ?? null);
  let returnDate: Date | null = null;
  if (endsAt && endsAt.getTime() - startsAt.getTime() > 36 * 3600_000) {
    // Multi-day event → treat end as return date
    returnDate = calendarDay(endsAt);
  }

  // Ignore ancient past (> 2 years) — noise
  if (startsAt.getTime() < now.getTime() - 730 * 86400_000) {
    return { ok: false, reason: "too_old" };
  }

  return {
    ok: true,
    trip: {
      externalEventId: ev.externalEventId,
      provider: ev.provider ?? "google",
      departureCity: from,
      destinationCity: to,
      departureDate: calendarDay(startsAt),
      returnDate,
      direction,
      confidence,
      signals: route.signals,
    },
  };
}

/** Parse many events; drop rejects. Dedupes by externalEventId (last wins). */
export function parseFlightEvents(
  events: CalendarEventInput[],
  now: Date = new Date(),
): { trips: ParsedFlightTrip[]; rejected: Array<{ id: string; reason: string }> } {
  const byId = new Map<string, ParsedFlightTrip>();
  const rejected: Array<{ id: string; reason: string }> = [];
  for (const ev of events) {
    const r = parseFlightEvent(ev, now);
    if (r.ok) byId.set(r.trip.externalEventId, r.trip);
    else rejected.push({ id: ev.externalEventId, reason: r.reason });
  }
  return { trips: [...byId.values()], rejected };
}
