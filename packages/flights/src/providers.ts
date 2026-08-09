import { createHash, randomBytes } from "node:crypto";
import type { BookFlightInput, FlightBooking, FlightOption, FlightProvider, FlightSearchQuery } from "./types.js";
import { isoDate } from "./parse.js";

/** Deterministic corridor options when no live flight API is configured. */
export class DemoFlightProvider implements FlightProvider {
  readonly name = "demo";

  async search(q: FlightSearchQuery): Promise<FlightOption[]> {
    const origin = q.origin.toUpperCase();
    const destination = q.destination.toUpperCase();
    const dateStr = typeof q.departDate === "string" ? q.departDate : isoDate(q.departDate);
    const base = new Date(`${dateStr}T12:00:00`);
    const templates = [
      { airline: "Delta", code: "DL", fn: "154", depH: 20, depM: 30, hours: 10.5, stops: 0, price: 780 },
      { airline: "United", code: "UA", fn: "982", depH: 18, depM: 15, hours: 12, stops: 1, price: 640 },
      { airline: "Emirates", code: "EK", fn: "501", depH: 22, depM: 5, hours: 14, stops: 1, price: 920 },
    ];
    return templates.map((t, i) => {
      const departAt = new Date(base);
      departAt.setHours(t.depH, t.depM, 0, 0);
      const arriveAt = new Date(departAt.getTime() + t.hours * 3600_000);
      const offerId = `demo_${origin}_${destination}_${dateStr}_${i}`;
      return {
        offerId,
        airline: t.airline,
        airlineCode: t.code,
        flightNumber: `${t.code}${t.fn}`,
        origin,
        destination,
        departAt,
        arriveAt,
        durationMinutes: Math.round(t.hours * 60),
        stops: t.stops,
        priceCents: t.price * 100,
        currency: "USD",
        cabin: q.cabin ?? "economy",
      };
    });
  }

  async book(input: BookFlightInput, offer: FlightOption): Promise<FlightBooking> {
    if (!input.paymentMethodId && !input.allowDemo) {
      return {
        bookingRef: "",
        status: "pending_payment",
        offer,
        passengerName: input.passengerName,
        message: "Link a payment method (Apple Pay / card) to finish booking.",
      };
    }
    const bookingRef = `MNB-${randomBytes(3).toString("hex").toUpperCase()}`;
    return {
      bookingRef,
      status: input.paymentMethodId ? "confirmed" : "demo_confirmed",
      offer,
      passengerName: input.passengerName,
      message: input.paymentMethodId
        ? `Booked ${offer.airline} ${offer.flightNumber ?? ""} — confirmation ${bookingRef}.`
        : `Demo booking ${bookingRef} held for ${offer.airline} ${offer.flightNumber ?? ""}. Connect a live flight API + payment to ticket for real.`,
    };
  }
}

/** SerpAPI Google Flights (search only). */
export class SerpFlightProvider implements FlightProvider {
  readonly name = "serpapi";
  private demo = new DemoFlightProvider();

  async search(q: FlightSearchQuery): Promise<FlightOption[]> {
    const apiKey = process.env.SERPAPI_API_KEY?.trim();
    if (!apiKey) return this.demo.search(q);

    const dateStr = typeof q.departDate === "string" ? q.departDate : isoDate(q.departDate);
    const params = new URLSearchParams({
      engine: "google_flights",
      departure_id: q.origin.toUpperCase(),
      arrival_id: q.destination.toUpperCase(),
      outbound_date: dateStr,
      type: "2", // one-way
      currency: "USD",
      hl: "en",
      api_key: apiKey,
    });
    const res = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!res.ok) throw new Error(`SerpAPI flights ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      error?: string;
      best_flights?: any[];
      other_flights?: any[];
    };
    if (data.error) throw new Error(`SerpAPI flights: ${data.error}`);

    const rows = [...(data.best_flights ?? []), ...(data.other_flights ?? [])].slice(0, q.limit ?? 5);
    const options: FlightOption[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const legs = row.flights ?? [];
      const first = legs[0];
      const last = legs[legs.length - 1] ?? first;
      if (!first?.departure_airport?.id || !last?.arrival_airport?.id) continue;
      const departAt = new Date(first.departure_airport.time);
      const arriveAt = new Date(last.arrival_airport.time);
      if (Number.isNaN(departAt.getTime()) || Number.isNaN(arriveAt.getTime())) continue;
      const price = typeof row.price === "number" ? Math.round(row.price * 100) : 0;
      if (price <= 0) continue;
      const airline = first.airline ?? "Airline";
      const offerId = `serp_${createHash("sha1").update(JSON.stringify(row)).digest("hex").slice(0, 16)}`;
      options.push({
        offerId,
        airline,
        airlineCode: first.airline_logo ? undefined : first.flight_number?.slice(0, 2),
        flightNumber: first.flight_number,
        origin: first.departure_airport.id,
        destination: last.arrival_airport.id,
        departAt,
        arriveAt,
        durationMinutes: Number(row.total_duration) || Math.round((arriveAt.getTime() - departAt.getTime()) / 60000),
        stops: Math.max(0, legs.length - 1),
        priceCents: price,
        currency: "USD",
        cabin: q.cabin ?? "economy",
        raw: row,
      });
    }
    if (options.length === 0) return this.demo.search(q);
    if (q.arriveBy) {
      options.sort((a, b) => {
        const aOk = a.arriveAt.getTime() <= q.arriveBy!.getTime() ? 0 : 1;
        const bOk = b.arriveAt.getTime() <= q.arriveBy!.getTime() ? 0 : 1;
        return aOk - bOk || a.priceCents - b.priceCents;
      });
    }
    return options.slice(0, q.limit ?? 5);
  }

  async book(input: BookFlightInput, offer: FlightOption): Promise<FlightBooking> {
    // SerpAPI cannot ticket — demo/hold path until Duffel/Soar book is wired.
    return this.demo.book({ ...input, allowDemo: true }, offer);
  }
}

export function makeFlightProvider(): FlightProvider {
  if (process.env.SERPAPI_API_KEY?.trim()) return new SerpFlightProvider();
  return new DemoFlightProvider();
}

export function hasLiveFlightSearch(): boolean {
  return Boolean(process.env.SERPAPI_API_KEY?.trim() || process.env.DUFFEL_ACCESS_TOKEN?.trim());
}
