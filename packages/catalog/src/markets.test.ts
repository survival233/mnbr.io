import { describe, expect, it } from "vitest";
import { shopMarketForCity } from "./markets.js";

describe("shopMarketForCity", () => {
  it("resolves the US catalog for a US hub or catchment", () => {
    expect(shopMarketForCity("New York")?.id).toBe("us");
    expect(shopMarketForCity("Brooklyn")?.id).toBe("us");
  });

  it("has no catalog for a hub outside wired markets", () => {
    expect(shopMarketForCity("Accra")).toBeUndefined();
    expect(shopMarketForCity("San José")).toBeUndefined();
  });
});
