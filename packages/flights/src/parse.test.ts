import { describe, expect, it } from "vitest";
import {
  isTravelIntent,
  parseTravelIntent,
  parseDepartDate,
  toAirportCode,
  resolvePlace,
} from "./parse.js";

describe("travel parse", () => {
  it("detects travel intent", () => {
    expect(isTravelIntent("I need to be in New York Friday morning. Find me a flight.")).toBe(true);
    expect(isTravelIntent("AirPods please")).toBe(false);
    expect(isTravelIntent("JFK to Accra")).toBe(true);
  });

  it("parses friday morning to NY", () => {
    const p = parseTravelIntent("I need to be in New York Friday morning. Find me a flight.");
    expect(toAirportCode(p.destination ?? "")).toBe("JFK");
    expect(p.departDate).toBeTruthy();
    expect(p.arriveBy).toBeInstanceOf(Date);
  });

  it("parses City to City on ordinal date", () => {
    const p = parseTravelIntent("New York to Accra on 15th August");
    expect(toAirportCode(String(p.origin))).toBe("JFK");
    expect(toAirportCode(String(p.destination))).toBe("ACC");
    expect(p.departDate).toBe("2026-08-15");
  });

  it("parses JFK to Accra", () => {
    const p = parseTravelIntent("JFK to Accra");
    expect(toAirportCode(String(p.origin))).toBe("JFK");
    expect(toAirportCode(String(p.destination))).toBe("ACC");
  });

  it("resolves bare place replies", () => {
    expect(resolvePlace("New York")).toBe("JFK");
    expect(resolvePlace("New York JFK")).toBe("JFK");
    expect(resolvePlace("Accra")).toBe("ACC");
  });

  it("parses ordinal depart dates", () => {
    expect(parseDepartDate("15th August")).toBe("2026-08-15");
    expect(parseDepartDate("August 15")).toBe("2026-08-15");
  });
});
