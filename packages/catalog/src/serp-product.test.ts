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
  it("upgrades to the price-closest direct URL from the listing's own approved store", async () => {
    mockFetch({
      product_results: {
        thumbnails: ["https://serpapi.example/product-thumb.jpg"],
        stores: [
          { name: "Walmart", link: "https://www.walmart.com/ip/9", extracted_price: 1099 },
          { name: "Apple", link: "https://www.apple.com/shop/product/refurb", extracted_price: 899 },
          { name: "Apple", link: "https://www.apple.com/shop/buy-iphone/iphone-15-pro", extracted_price: 1199 },
        ],
      },
    });
    const out = await resolveDirectStoreUrl(listing());
    expect(out.urlVerified).toBe(true);
    // Apple entry priced closest to the $1199 listing, not the $899 refurb or Walmart.
    expect(out.productUrl).toBe("https://www.apple.com/shop/buy-iphone/iphone-15-pro");
    // Existing listing image is kept (no store-hosted image exists to upgrade to).
    expect(out.imageUrl).toBe("https://serpapi.example/thumb.jpg");
  });

  it("falls back to a product thumbnail only when the listing has no image", async () => {
    mockFetch({
      product_results: {
        thumbnails: ["https://serpapi.example/product-thumb.jpg"],
        stores: [{ name: "Apple", link: "https://www.apple.com/shop/buy-iphone/iphone-15-pro", extracted_price: 1199 }],
      },
    });
    const out = await resolveDirectStoreUrl(listing({ imageUrl: "" }));
    expect(out.urlVerified).toBe(true);
    expect(out.imageUrl).toBe("https://serpapi.example/product-thumb.jpg");
  });

  it("flags urlVerified false when no store from the listing's own store has a direct link", async () => {
    mockFetch({
      product_results: { stores: [{ name: "Walmart", link: "https://www.walmart.com/ip/9", extracted_price: 1099 }] },
    });
    const out = await resolveDirectStoreUrl(listing());
    expect(out.urlVerified).toBe(false);
    expect(out.productUrl).toBe("https://www.google.com/shopping/product/1"); // unchanged
  });

  it("rejects an unapproved store domain even if the name matches", async () => {
    mockFetch({ product_results: { stores: [{ name: "Apple", link: "https://notapple.example/x" }] } });
    const out = await resolveDirectStoreUrl(listing());
    expect(out.urlVerified).toBe(false);
  });

  it("returns the listing unchanged when it has no product id", async () => {
    mockFetch({ product_results: { stores: [] } });
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
