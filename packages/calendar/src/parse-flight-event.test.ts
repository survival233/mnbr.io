import { describe, it, expect } from "vitest";
import { parseFlightEvent, parseFlightEvents } from "./parse-flight-event";
import { normalizeCity, inferDirection } from "./cities";

const NOW = new Date("2026-08-01T12:00:00Z");

describe("normalizeCity", () => {
  it("maps IATA + aliases to Accra", () => {
    expect(normalizeCity("ACC")).toBe("Accra");
    expect(normalizeCity("Kotoka International Airport")).toBe("Accra");
    expect(normalizeCity("accra")).toBe("Accra");
  });
  it("maps Greater Accra delivery cities to Accra for matching", () => {
    expect(normalizeCity("Tema")).toBe("Accra");
    expect(normalizeCity("East Legon")).toBe("Accra");
    expect(normalizeCity("Kasoa")).toBe("Accra");
  });
  it("maps US hubs", () => {
    expect(normalizeCity("JFK")).toBe("New York");
    expect(normalizeCity("EWR")).toBe("Newark");
    expect(normalizeCity("ATL")).toBe("Atlanta");
  });
});

describe("inferDirection", () => {
  it("accepts any distinct origin→destination pair", () => {
    expect(inferDirection("New York", "Accra")).toBe("us_to_gh");
    expect(inferDirection("Accra", "New York")).toBe("gh_to_us");
    expect(inferDirection("New York", "San José")).toBe("us_to_gh");
    expect(inferDirection("London", "Buenos Aires")).toBe("us_to_gh");
    expect(inferDirection("London", "New York")).toBe("gh_to_us");
    expect(inferDirection("New York", "New York")).toBeNull();
  });
});

describe("parseFlightEvent", () => {
  it("parses a Delta confirmation-style title", () => {
    const r = parseFlightEvent({
      externalEventId: "ek-1",
      title: "Delta flight DL406 JFK → ACC",
      location: "Kotoka International Airport",
      startsAt: "2026-08-12T22:00:00Z",
      provider: "google",
    }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trip.destinationCity).toBe("Accra");
    expect(r.trip.departureCity).toBe("New York");
    expect(r.trip.direction).toBe("us_to_gh");
    expect(r.trip.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("parses 'Flight to Accra' without inventing an origin", () => {
    const r = parseFlightEvent({
      externalEventId: "ek-2",
      title: "Flight to Accra",
      startsAt: new Date("2026-08-20T10:00:00Z"),
    }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trip.destinationCity).toBe("Accra");
    expect(r.trip.departureCity).toBe("Unknown");
  });

  it("rejects birthday parties", () => {
    const r = parseFlightEvent({
      externalEventId: "ek-3",
      title: "Mom's birthday dinner",
      location: "Accra",
      startsAt: "2026-08-10T18:00:00Z",
    }, NOW);
    expect(r.ok).toBe(false);
  });

  it("accepts a flight that is not a Ghana corridor", () => {
    const r = parseFlightEvent({
      externalEventId: "ek-4",
      title: "Flight BA178 LHR → JFK",
      startsAt: "2026-08-10T10:00:00Z",
    }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trip.departureCity).toBe("London");
    expect(r.trip.destinationCity).toBe("New York");
  });

  it("parses a non-Ghana destination pair", () => {
    const r = parseFlightEvent({
      externalEventId: "ek-5",
      title: "Flight AA900 JFK → EZE",
      startsAt: "2026-08-18T22:00:00Z",
    }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trip.departureCity).toBe("New York");
    expect(r.trip.destinationCity).toBe("Buenos Aires");
    expect(r.trip.direction).toBe("us_to_gh");
  });

  it("dedupes by externalEventId", () => {
    const { trips } = parseFlightEvents([
      { externalEventId: "x", title: "Flight to Accra", startsAt: "2026-08-15T00:00:00Z" },
      { externalEventId: "x", title: "Flight to Kumasi", startsAt: "2026-08-16T00:00:00Z" },
    ], NOW);
    expect(trips).toHaveLength(1);
    expect(trips[0].destinationCity).toBe("Kumasi");
  });
});
