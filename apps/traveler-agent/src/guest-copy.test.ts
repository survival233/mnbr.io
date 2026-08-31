import { describe, expect, it } from "vitest";
import { travelerAsk } from "@manebra/dialog";

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
