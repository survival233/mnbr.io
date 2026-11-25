import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductListing } from "./types.js";
import { resolveDirectStoreUrl, directStoreUrlsEnabled } from "./serp-product.js";

function listing(p: Partial<ProductListing> = {}): ProductListing {
  return {
    listingId: "apple:1",
    storeName: "Apple Store",
    storeSlug: "apple",
    productTitle: "Apple iPhone 15 Pro Max 256GB",
    priceCents: 119_900,
    currency: "USD",
    availability: "in_stock",
    availabilityLabel: "In Stock",
    productUrl: "https://www.google.com/shopping/product/1",
    productId: "prod_123",
    imageUrl: "https://serpapi.example/thumb.jpg",
    shoppingCity: "",
    category: "electronics",
    ...p,
  };
}

function mockFetch(json: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => json }) as unknown as Response));
}

beforeEach(() => vi.stubEnv("SERPAPI_API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveDirectStoreUrl", () => {
  it("upgrades to the direct approved-store URL and the store's own image", async () => {
    mockFetch({
      product_results: { media: [{ type: "image", link: "https://store.apple.com/real.jpg" }] },
      sellers_results: {
        online_sellers: [
          { name: "Walmart", direct_link: "https://www.walmart.com/ip/9" },
          { name: "Apple", direct_link: "https://www.apple.com/shop/buy-iphone/iphone-15-pro" },
        ],
      },
    });
    const out = await resolveDirectStoreUrl(listing());
    expect(out.urlVerified).toBe(true);
    expect(out.productUrl).toBe("https://www.apple.com/shop/buy-iphone/iphone-15-pro");
    expect(out.imageUrl).toBe("https://store.apple.com/real.jpg");
  });

  it("flags urlVerified false when no seller from the listing's store has a direct link", async () => {
    mockFetch({ sellers_results: { online_sellers: [{ name: "Walmart", direct_link: "https://www.walmart.com/ip/9" }] } });
    const out = await resolveDirectStoreUrl(listing());
    expect(out.urlVerified).toBe(false);
    expect(out.productUrl).toBe("https://www.google.com/shopping/product/1"); // unchanged
  });

  it("rejects an unapproved seller domain even if it matches the name", async () => {
    mockFetch({ sellers_results: { online_sellers: [{ name: "Apple", direct_link: "https://notapple.example/x" }] } });
    const out = await resolveDirectStoreUrl(listing());
    expect(out.urlVerified).toBe(false);
  });

  it("returns the listing unchanged when it has no product id", async () => {
    mockFetch({ sellers_results: { online_sellers: [] } });
    const out = await resolveDirectStoreUrl(listing({ productId: undefined }));
    expect(out).toEqual(listing({ productId: undefined }));
  });

  it("returns the listing unchanged on a fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const out = await resolveDirectStoreUrl(listing());
    expect(out.urlVerified).toBeUndefined();
    expect(out.productUrl).toBe("https://www.google.com/shopping/product/1");
  });
});

describe("directStoreUrlsEnabled", () => {
  it("is off without the flag and on only with flag + key", () => {
    expect(directStoreUrlsEnabled()).toBe(false);
    vi.stubEnv("CATALOG_RESOLVE_DIRECT_URL", "1");
    expect(directStoreUrlsEnabled()).toBe(true);
    vi.stubEnv("SERPAPI_API_KEY", "");
    expect(directStoreUrlsEnabled()).toBe(false);
  });
});
