import { describe, expect, it } from "vitest";
import { resolveCategory, resolveMerchant, resolveCountry, resolveCorridor } from "./resolve";

describe("resolveCategory", () => {
  it("maps an item hint to a canonical compliance category", () => {
    expect(resolveCategory("can you find me an iphone")).toBe("electronics");
    expect(resolveCategory("a bottle of perfume")).toBe("cosmetics_sealed");
    expect(resolveCategory("kente cloth")).toBe("textiles_kente");
  });
  it("returns null for an unrecognized item", () => {
    expect(resolveCategory("a pet iguana")).toBeNull();
  });
});

describe("resolveMerchant", () => {
  it("maps a store name to a domain", () => {
    expect(resolveMerchant("in the apple store")).toBe("apple.com");
    expect(resolveMerchant("from amazon")).toBe("amazon.com");
  });
  it("returns null for an unknown store", () => {
    expect(resolveMerchant("the corner shop")).toBeNull();
  });
});

describe("resolveCountry / resolveCorridor", () => {
  it("resolves served countries", () => {
    expect(resolveCountry("deliver to Accra")).toBe("GH");
    expect(resolveCountry("I'm in New York")).toBe("US");
  });
  it("builds a valid corridor and rejects same/unknown", () => {
    expect(resolveCorridor("US", "GH")).toBe("us_to_gh");
    expect(resolveCorridor("GH", "US")).toBe("gh_to_us");
    expect(resolveCorridor("US", "US")).toBeNull();
    expect(resolveCorridor("US", null)).toBeNull();
  });
});
