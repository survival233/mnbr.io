/**
 * Persistent trip slot state for the traveler agent.
 *
 * Every inbound message: extract → merge → missing_fields → next question.
 * Never ask for a field that is already set/confirmed.
 */
import {
  parseTravelIntent,
  parseDepartDate,
  isoDate,
} from "@manebra/flights";
import { guestCityName, isDestinationShaped, parseTripDestination, parseTripOrigin } from "@manebra/dialog";

export type TripField = "origin" | "destination" | "departure_date";

export type TripState = {
  origin?: string;
  destination?: string;
  departure_date?: string;
  /** Fields the user has provided or confirmed — never re-ask these. */
  confirmed: TripField[];
  arrive_by?: string;
  note?: string;
  updated_at: number;
};

export function blankTrip(): TripState {
  return { confirmed: [], updated_at: Date.now() };
}

export function missingFields(trip: TripState): TripField[] {
  const missing: TripField[] = [];
  if (!trip.destination) missing.push("destination");
  if (!trip.origin) missing.push("origin");
  if (!trip.departure_date) missing.push("departure_date");
  return missing;
}

export function isTripComplete(trip: TripState): boolean {
  return missingFields(trip).length === 0;
}

export function tripSnapshot(trip: TripState): {
  origin?: string;
  destination?: string;
  departure_date?: string;
} {
  return {
    origin: trip.origin,
    destination: trip.destination,
    departure_date: trip.departure_date,
  };
}

function confirm(trip: TripState, field: TripField) {
  if (!trip.confirmed.includes(field)) trip.confirmed.push(field);
}

/** Persist guest city names (Lagos), never IATA (LOS / ACC). */
function asGuestCity(raw: string | undefined | null): string | undefined {
  if (!raw?.trim()) return undefined;
  return (
    parseTripDestination(raw) ??
    parseTripOrigin(raw) ??
    guestCityName(raw) ??
    undefined
  );
}

function stampGuest(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  return guestCityName(raw) ?? raw.trim();
}

export type ExtractedSlots = {
  origin?: string;
  destination?: string;
  departure_date?: string;
  arrive_by?: string;
  note?: string;
  /** True when the message looked like a full route (A to B), not a bare place. */
  explicit_route?: boolean;
  bare_place?: string;
};

/** Entity/slot extraction from a single user message. */
export function extractSlots(text: string): ExtractedSlots {
  const t = text.trim();
  const out: ExtractedSlots = {};
  if (!t) return out;

  const parsed = parseTravelIntent(t);
  if (parsed.origin) {
    const o = asGuestCity(String(parsed.origin));
    if (o) out.origin = o;
  }
  if (parsed.destination) {
    const d = asGuestCity(String(parsed.destination));
    if (d) out.destination = d;
  }
  if (!out.destination) {
    const dest = parseTripDestination(t);
    if (dest && isDestinationShaped(t)) out.destination = dest;
  }
  if (parsed.departDate) {
    out.departure_date =
      typeof parsed.departDate === "string" ? parsed.departDate : isoDate(parsed.departDate);
  }
  if (parsed.arriveBy) out.arrive_by = parsed.arriveBy.toISOString();
  if (parsed.note) out.note = parsed.note;

  if (out.origin && out.destination) out.explicit_route = true;

  if (!out.departure_date) {
    const d = parseDepartDate(t);
    if (d) out.departure_date = d;
  }

  // Bare place reply (e.g. "New York", "Lagos") when no route was parsed.
  if (!out.origin && !out.destination) {
    const place = parseTripDestination(t) ?? parseTripOrigin(t);
    if (place) out.bare_place = place;
  }

  return out;
}

/**
 * Merge extracted slots into persistent trip state.
 * - Explicit extractions always update that field and mark confirmed.
 * - Dest-shaped utterances replace destination (Lagos after Accra is REPAIR, not a loop).
 * - Bare place fills only the first missing place slot (never overwrites confirmed).
 */
export function mergeTripState(trip: TripState, text: string): ExtractedSlots {
  if (trip.destination) trip.destination = stampGuest(trip.destination) ?? trip.destination;
  if (trip.origin) trip.origin = stampGuest(trip.origin) ?? trip.origin;

  const extracted = extractSlots(text);

  if (extracted.origin) {
    trip.origin = extracted.origin;
    confirm(trip, "origin");
  }
  if (extracted.destination) {
    trip.destination = extracted.destination;
    confirm(trip, "destination");
  }
  if (extracted.departure_date) {
    trip.departure_date = extracted.departure_date;
    confirm(trip, "departure_date");
  }
  if (extracted.arrive_by) trip.arrive_by = extracted.arrive_by;
  if (extracted.note) trip.note = extracted.note;

  if (extracted.bare_place) {
    const place = extracted.bare_place;
    const missing = missingFields(trip);
    if (isDestinationShaped(text) || missing.includes("destination")) {
      if (place !== trip.origin) {
        trip.destination = place;
        confirm(trip, "destination");
      }
    } else if (missing.includes("origin") && place !== trip.destination) {
      trip.origin = place;
      confirm(trip, "origin");
    }
  }

  trip.updated_at = Date.now();
  return extracted;
}

/** Next question for the first missing field only. Guest copy uses city names, never IATA. */
export function nextQuestion(trip: TripState): { field: TripField; text: string } | null {
  const missing = missingFields(trip);
  if (!missing.length) return null;
  const field = missing[0]!;
  const dest = stampGuest(trip.destination) ?? trip.destination;
  const origin = stampGuest(trip.origin) ?? trip.origin;
  switch (field) {
    case "destination":
      return {
        field,
        text: `Where are you flying? City is fine.`,
      };
    case "origin":
      return {
        field,
        text: trip.departure_date
          ? `Got ${dest} on ${trip.departure_date} — where are you flying from?`
          : `Got ${dest} — where are you flying from?`,
      };
    case "departure_date":
      return {
        field,
        text: `Got ${origin} → ${dest}. What day do you want to depart?`,
      };
  }
}

/** Sync legacy flat session fields ↔ trip (for older persisted sessions). */
export function ensureTrip(s: {
  trip?: TripState;
  travelOrigin?: string;
  travelDestination?: string;
  travelDepartDate?: string;
  travelArriveBy?: Date;
}): TripState {
  if (!s.trip) {
    s.trip = blankTrip();
    if (s.travelDestination) {
      s.trip.destination = stampGuest(s.travelDestination) ?? s.travelDestination;
      confirm(s.trip, "destination");
    }
    if (s.travelOrigin) {
      s.trip.origin = stampGuest(s.travelOrigin) ?? s.travelOrigin;
      confirm(s.trip, "origin");
    }
    if (s.travelDepartDate) {
      s.trip.departure_date = s.travelDepartDate;
      confirm(s.trip, "departure_date");
    }
    if (s.travelArriveBy) s.trip.arrive_by = s.travelArriveBy.toISOString();
  } else {
    if (s.trip.destination) s.trip.destination = stampGuest(s.trip.destination) ?? s.trip.destination;
    if (s.trip.origin) s.trip.origin = stampGuest(s.trip.origin) ?? s.trip.origin;
  }
  s.travelOrigin = s.trip.origin;
  s.travelDestination = s.trip.destination;
  s.travelDepartDate = s.trip.departure_date;
  return s.trip;
}

export function mirrorTripToLegacy(s: {
  trip?: TripState;
  travelOrigin?: string;
  travelDestination?: string;
  travelDepartDate?: string;
  travelArriveBy?: Date;
}): void {
  const trip = ensureTrip(s);
  s.travelOrigin = trip.origin;
  s.travelDestination = trip.destination;
  s.travelDepartDate = trip.departure_date;
  if (trip.arrive_by) s.travelArriveBy = new Date(trip.arrive_by);
}
