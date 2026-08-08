import { describe, it, expect } from "vitest";
import { matchVerifiedStore } from "./verified-stores.js";
import { listingIdFor, cacheListings, getCachedListing } from "./cache.js";
import type { ProductListing } from "./types.js";

describe("matchVerifiedStore", () => {
  it("matches by source name and by domain", () => {
    expect(matchVerifiedStore("Apple")?.slug).toBe("apple");
    expect(matchVerifiedStore("Best Buy")?.slug).toBe("bestbuy");
    expect(matchVerifiedStore("", "https://www.walmart.com/ip/123")?.slug).toBe("walmart");
    expect(matchVerifiedStore("Random Shop", "https://example.com")).toBeNull();
  });
});

describe("listing cache", () => {
  it("round-trips a selected listing", () => {
    const listing: ProductListing = {
      listingId: listingIdFor("apple", "https://www.apple.com/x"),
      storeName: "Apple Store",
      storeSlug: "apple",
      productTitle: "Test",
      priceCents: 100,
      currency: "USD",
      availability: "in_stock",
      availabilityLabel: "In Stock",
      productUrl: "https://www.apple.com/x",
      imageUrl: "",
      shoppingCity: "New York",
      category: "electronics",
    };
    cacheListings([listing]);
    expect(getCachedListing(listing.listingId)?.productTitle).toBe("Test");
  });
});
