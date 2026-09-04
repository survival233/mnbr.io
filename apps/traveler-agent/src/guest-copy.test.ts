import { describe, expect, it } from "vitest";
import {
  travelerAsk,
  TRAVELER_HI,
  TRAVELER_OPT_IN_ASK,
  TRAVELER_WALLET_ADD,
  TRAVELER_CARD_ON_FILE,
  asksToBookFlight,
} from "@manebra/dialog";

describe("traveler ask", () => {
  it("asks matching travelers with item, merchant, price, and earnings — no name", () => {
    const text = travelerAsk({
      city: "Accra",
      title: "AirPods Pro",
      merchant: "Apple",
      itemCents: 4299,
      earningsCents: 5000,
    }).join("\n");
    expect(text).toContain("You’re going to Accra.");
    expect(text).toContain("Someone needs AirPods Pro (Apple, $42.99).");
    expect(text).toContain("Traveler earnings $50.00.");
    expect(text).toContain("Want it?");
    expect(text).not.toMatch(/\b(Ama|Kofi|Nana)\b/);
    expect(text).not.toMatch(/Shop & Deliver/i);
  });
});

describe("traveler hi + opt-in + wallet", () => {
  it("offers a flight stub or a destination trip, without calendar or speculative Shop & Deliver", () => {
    expect(TRAVELER_HI).toMatch(/book a flight/i);
    expect(TRAVELER_HI).toMatch(/city/i);
    expect(TRAVELER_HI).not.toMatch(/calendar/i);
    expect(TRAVELER_HI).not.toMatch(/earn/i);
    expect(TRAVELER_HI).not.toMatch(/Where are you (headed|travelling|traveling)/i);
  });

  it("asks Shop & Deliver opt-in explicitly and only after a funded match is possible", () => {
    expect(TRAVELER_OPT_IN_ASK).toMatch(/Shop & Deliver/);
    expect(TRAVELER_OPT_IN_ASK).toMatch(/funded/i);
    expect(TRAVELER_OPT_IN_ASK).toMatch(/Yes or no/i);
  });

  it("asks the traveler to add their own test card, not the shopper’s", () => {
    expect(TRAVELER_WALLET_ADD).toMatch(/4242/);
    expect(TRAVELER_WALLET_ADD).toMatch(/yours/i);
    expect(TRAVELER_WALLET_ADD).not.toMatch(/shopper/i);
    expect(TRAVELER_CARD_ON_FILE).toMatch(/Card’s on file/i);
  });

  it("detects a flight-booking ask", () => {
    expect(asksToBookFlight("book a flight")).toBe(true);
    expect(asksToBookFlight("1")).toBe(true);
    expect(asksToBookFlight("Lagos next week")).toBe(false);
  });
});
