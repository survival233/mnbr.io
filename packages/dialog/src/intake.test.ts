import { describe, expect, it } from "vitest";
import {
  parseTripDestination,
  parseDeliveryTown,
  guestCityName,
  isDestinationShaped,
  extractProductUrl,
  parseItem,
  classifyTurn,
  composeHostReply,
  type DialogSession,
} from "./index";

describe("traveler destination — any geo metro", () => {
  it("commits Lagos, London, Kumasi, New York from natural utterances", () => {
    expect(parseTripDestination("I'm going to Lagos")).toBe("Lagos");
    expect(parseTripDestination("London")).toBe("London");
    expect(parseTripDestination("Kumasi")).toBe("Kumasi");
    expect(parseTripDestination("New York")).toBe("New York");
    expect(parseTripDestination("I'm going to Accra")).toBe("Accra");
  });

  it("never returns IATA for guest copy", () => {
    expect(guestCityName("ACC")).toBe("Accra");
    expect(guestCityName("LOS")).toBe("Lagos");
    expect(guestCityName("JFK")).toBe("New York");
    expect(parseTripDestination("Lagos")).not.toBe("LOS");
    expect(parseTripDestination("Lagos")).not.toBe("ACC");
  });

  it("treats a later city as a destination replace, not an Accra loop", () => {
    expect(isDestinationShaped("I'm going to Lagos")).toBe(true);
    expect(parseTripDestination("I'm going to Lagos")).toBe("Lagos");
    expect(parseDeliveryTown("Lagos")).toBe("Lagos");
  });
});

describe("item intake — URL is first-class", () => {
  it("extracts an http(s) product URL and does not treat it as a product name", () => {
    const url = "https://www.ebay.com/itm/usb-c-charger";
    expect(extractProductUrl(`shop this ${url}`)).toBe(url);
    expect(parseItem(url)).toBeNull();
  });

  it("classifies a pasted URL as NEW item intake", () => {
    const s: DialogSession = { step: "idle", pending: null };
    const t = classifyTurn(s, { text: "https://www.amazon.com/dp/B0CHARGER" });
    expect(t.act).toBe("NEW");
    expect(t.query).toMatch(/^https:\/\/www\.amazon\.com/);
  });
});

describe("composeHostReply — no IATA leftovers", () => {
  it("does not print Still on ACC", () => {
    const beats = composeHostReply({
      act: "REASK",
      stay: { lastItem: "ACC" },
      next: "Where are you flying?",
    });
    expect(beats.join(" ")).not.toMatch(/Still on/i);
    expect(beats.join(" ")).not.toMatch(/\bACC\b/);
    expect(beats.join(" ")).toMatch(/Where are you flying/);
  });
});
