import { describe, expect, it } from "vitest";
import { isTravelIntent, parseTravelIntent, toAirportCode } from "./parse.js";

describe("travel parse", () => {
  it("detects travel intent", () => {
    expect(isTravelIntent("I need to be in New York Friday morning. Find me a flight.")).toBe(true);
    expect(isTravelIntent("AirPods please")).toBe(false);
  });

  it("parses friday morning to NY", () => {
    const p = parseTravelIntent("I need to be in New York Friday morning. Find me a flight.");
    expect(toAirportCode(p.destination ?? "")).toBe("JFK");
    expect(p.departDate).toBeTruthy();
    expect(p.arriveBy).toBeInstanceOf(Date);
  });
});
