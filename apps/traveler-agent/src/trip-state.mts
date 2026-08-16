/**
 * Persistent trip slot state for the traveler agent.
 *
 * Every inbound message: extract → merge → missing_fields → next question.
 * Never ask for a field that is already set/confirmed.
 */
import {
  parseTravelIntent,
  parseDepartDate,
  toAirportCode,
  resolvePlace,
  isoDate,
} from "@manebra/flights";

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

function asAirport(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  return toAirportCode(raw) ?? (/^[A-Za-z]{3}$/.test(raw.trim()) ? raw.trim().toUpperCase() : undefined);
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
    const o = asAirport(String(parsed.origin));
    if (o) out.origin = o;
  }
  if (parsed.destination) {
    const d = asAirport(String(parsed.destination));
    if (d) out.destination = d;
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

  // Bare place reply (e.g. "New York", "JFK") when no route was parsed.
  if (!out.origin && !out.destination) {
    const place = resolvePlace(t);
    if (place) out.bare_place = place;
  } else if (!out.origin || !out.destination) {
    // "New York JFK" style already handled by resolvePlace inside toAirportCode paths
  }

  return out;
}

/**
 * Merge extracted slots into persistent trip state.
 * - Explicit extractions always update that field and mark confirmed.
 * - Bare place fills only the first missing place slot (never overwrites confirmed).
 */
export function mergeTripState(trip: TripState, text: string): ExtractedSlots {
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
    // Fill only missing place fields; never overwrite confirmed ones.
    if (missing.includes("destination") && place !== trip.origin) {
      trip.destination = place;
      confirm(trip, "destination");
    } else if (missing.includes("origin") && place !== trip.destination) {
      trip.origin = place;
      confirm(trip, "origin");
    }
  }

  trip.updated_at = Date.now();
  return extracted;
}

/** Next question for the first missing field only. */
export function nextQuestion(trip: TripState): { field: TripField; text: string } | null {
  const missing = missingFields(trip);
  if (!missing.length) return null;
  const field = missing[0]!;
  switch (field) {
    case "destination":
      return {
        field,
        text: `Where are you flying? City or airport is fine.`,
      };
    case "origin":
      return {
        field,
        text: trip.departure_date
          ? `Got ${trip.destination} on ${trip.departure_date} — where are you flying from? (city or airport code)`
          : `Got ${trip.destination} — where are you flying from? (city or airport code)`,
      };
    case "departure_date":
      return {
        field,
        text: `Got ${trip.origin} → ${trip.destination}. What day do you want to depart?`,
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
      s.trip.destination = s.travelDestination;
      confirm(s.trip, "destination");
    }
    if (s.travelOrigin) {
      s.trip.origin = s.travelOrigin;
      confirm(s.trip, "origin");
    }
    if (s.travelDepartDate) {
      s.trip.departure_date = s.travelDepartDate;
      confirm(s.trip, "departure_date");
    }
    if (s.travelArriveBy) s.trip.arrive_by = s.travelArriveBy.toISOString();
  }
  // Keep legacy mirrors for any leftover readers.
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
