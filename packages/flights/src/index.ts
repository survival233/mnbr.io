import type { FlightBooking, FlightOption, FlightSearchQuery, BookFlightInput } from "./types.js";
import { makeFlightProvider, hasLiveFlightSearch } from "./providers.js";
import {
  formatFlightOption,
  isTravelIntent,
  parseTravelIntent,
  toAirportCode,
  cityFromAirport,
  isoDate,
} from "./parse.js";

export type {
  FlightOption,
  FlightSearchQuery,
  FlightBooking,
  BookFlightInput,
  CabinClass,
  FlightProvider,
} from "./types.js";

export {
  formatFlightOption,
  isTravelIntent,
  parseTravelIntent,
  toAirportCode,
  cityFromAirport,
  isoDate,
  makeFlightProvider,
  hasLiveFlightSearch,
};

export async function searchFlights(q: FlightSearchQuery): Promise<FlightOption[]> {
  const origin = toAirportCode(q.origin) ?? q.origin.toUpperCase();
  const destination = toAirportCode(q.destination) ?? q.destination.toUpperCase();
  const provider = makeFlightProvider();
  return provider.search({ ...q, origin, destination, limit: q.limit ?? 5 });
}

export async function bookFlight(
  input: BookFlightInput,
  offer: FlightOption,
): Promise<FlightBooking> {
  const provider = makeFlightProvider();
  const allowDemo =
    input.allowDemo ??
    (process.env.FLIGHTS_ALLOW_DEMO === "1" ||
      process.env.FLIGHTS_ALLOW_DEMO === "true" ||
      !process.env.DUFFEL_ACCESS_TOKEN);
  return provider.book({ ...input, allowDemo }, offer);
}
