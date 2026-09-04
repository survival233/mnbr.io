import { describe, expect, it } from "vitest";
import { blankTrip, mergeTripState, missingFields, nextQuestion } from "./trip-state.mts";

describe("traveler trip destination — any geo city", () => {
  it("commits Lagos and advances past the city slot", () => {
    const trip = blankTrip();
    mergeTripState(trip, "I'm going to Lagos");
    expect(trip.destination).toBe("Lagos");
    expect(trip.destination).not.toBe("LOS");
    expect(trip.destination).not.toBe("ACC");
    expect(missingFields(trip)).not.toContain("destination");
    const ask = nextQuestion(trip);
    expect(ask?.field).not.toBe("destination");
    expect(ask?.text ?? "").not.toMatch(/\bACC\b/);
    expect(ask?.text ?? "").not.toMatch(/Still on/i);
  });

  it("is destination + date; origin is optional; opt-in is never inferred", () => {
    const trip = blankTrip();
    mergeTripState(trip, "I'm going to Lagos next Friday");
    expect(trip.destination).toBe("Lagos");
    expect(missingFields(trip)).not.toContain("origin");
    expect(missingFields(trip)).not.toContain("destination");
    expect(trip.optedIn).toBeUndefined();
    if (missingFields(trip).includes("departure_date")) {
      mergeTripState(trip, "next Friday");
    }
    expect(missingFields(trip)).toEqual([]);
    expect(trip.optedIn).toBeUndefined();
    expect(nextQuestion(trip)).toBeNull();
  });

  it("commits London, Kumasi, and New York the same way", () => {
    for (const [utterance, city] of [
      ["London", "London"],
      ["I'm going to Kumasi", "Kumasi"],
      ["New York", "New York"],
    ] as const) {
      const trip = blankTrip();
      mergeTripState(trip, utterance);
      expect(trip.destination).toBe(city);
      expect(missingFields(trip)).not.toContain("destination");
    }
  });

  it("still commits Accra as one metro among many", () => {
    const trip = blankTrip();
    mergeTripState(trip, "I'm going to Accra");
    expect(trip.destination).toBe("Accra");
    const acc = blankTrip();
    mergeTripState(acc, "ACC");
    expect(acc.destination).toBe("Accra");
  });

  it("replaces an Accra leftover when a new destination city is named", () => {
    const trip = blankTrip();
    mergeTripState(trip, "Accra");
    expect(trip.destination).toBe("Accra");
    mergeTripState(trip, "I'm going to Lagos");
    expect(trip.destination).toBe("Lagos");
    expect(nextQuestion(trip)?.text ?? "").not.toMatch(/\bACC\b/);
  });

  it("stamps stored IATA to a guest city name", () => {
    const trip = blankTrip();
    trip.destination = "ACC";
    trip.confirmed.push("destination");
    mergeTripState(trip, "hi");
    expect(trip.destination).toBe("Accra");
  });
});
