import { describe, expect, it } from "vitest";
import { parseShopCountry, parseShopPlace, parseShoppingCity } from "./cities";

describe("parseShopPlace", () => {
  it("accepts a city the shopper prefers", () => {
    expect(parseShopPlace("Atlanta")).toBe("Atlanta");
    expect(parseShoppingCity("Brooklyn")).toBe("New York");
  });

  it("accepts a country, not only a city", () => {
    expect(parseShopCountry("US")).toBe("United States");
    expect(parseShopPlace("USA")).toBe("United States");
    expect(parseShopPlace("United States")).toBe("United States");
    expect(parseShopPlace("the US")).toBe("United States");
  });

  it("does not treat handover-only metros as a US shop place via country parse", () => {
    expect(parseShopCountry("Accra")).toBeNull();
  });
});
