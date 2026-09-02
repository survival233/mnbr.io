import { describe, it, expect } from "vitest";
import { matchVerifiedStore } from "./verified-stores.js";
import { listingIdFor, cacheListings, getCachedListing } from "./cache.js";
import { catalogSearchCity, listingsForMerchant } from "./search.js";
import { formatSkuCardList, formatShopPickList, listingsForPicker, listingsWithPhotos } from "./sku-cards.js";
import { parseProductHtml, listingFromUrlMeta } from "./product-url.js";
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

describe("catalogSearchCity — national, never invent NYC", () => {
  it("does not default shoppingCity to New York", () => {
    expect(catalogSearchCity(undefined)).toBe("");
    expect(catalogSearchCity(undefined)).not.toBe("New York");
    expect(catalogSearchCity("")).toBe("");
    expect(catalogSearchCity(null)).toBe("");
  });

  it("empty shoppingCity still searches (does not skip listings)", async () => {
    const { searchProducts } = await import("./search.js");
    const prev = process.env.SERPAPI_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    try {
      await expect(searchProducts({ query: "airpods" })).rejects.toThrow(/SERPAPI/);
    } finally {
      if (prev === undefined) delete process.env.SERPAPI_API_KEY;
      else process.env.SERPAPI_API_KEY = prev;
    }
  });
});

describe("SKU cards include image URL + title + price + merchant", () => {
  it("formats a compact card list", () => {
    const listing: ProductListing = {
      listingId: "amazon:1",
      storeName: "Amazon",
      storeSlug: "amazon",
      productTitle: "USB C Charger Block, Costyle 25W Dual Port",
      priceCents: 1599,
      currency: "USD",
      availability: "in_stock",
      availabilityLabel: "In Stock",
      productUrl: "https://www.amazon.com/x",
      imageUrl: "https://cdn.example.com/charger.jpg",
      shoppingCity: "",
      category: "electronics",
    };
    const text = formatSkuCardList([listing]);
    expect(text).toMatch(/USB C Charger/);
    expect(text).toMatch(/\$15\.99/);
    expect(text).toMatch(/Amazon/);
    expect(text).toMatch(/https:\/\/cdn\.example.com\/charger\.jpg/);
  });

  it("named item yields ≥2 photo SKUs and drops text-only rows", () => {
    const base = {
      currency: "USD" as const,
      availability: "in_stock" as const,
      availabilityLabel: "In Stock",
      productUrl: "https://example.com/x",
      shoppingCity: "",
      category: "electronics" as const,
    };
    const rows: ProductListing[] = [
      { ...base, listingId: "amazon:1", storeName: "Amazon", storeSlug: "amazon", productTitle: "USB-C Charger 25W", priceCents: 1599, imageUrl: "https://cdn.example.com/a.jpg" },
      { ...base, listingId: "target:1", storeName: "Target", storeSlug: "target", productTitle: "USB-C Charger", priceCents: 39999, imageUrl: "" },
      { ...base, listingId: "walmart:1", storeName: "Walmart", storeSlug: "walmart", productTitle: "Anker USB-C Charger", priceCents: 1899, imageUrl: "https://cdn.example.com/b.jpg" },
      { ...base, listingId: "apple:1", storeName: "Apple", storeSlug: "apple", productTitle: "USB-C Charge Cable", priceCents: 1900, imageUrl: "https://cdn.example.com/c.jpg" },
    ];
    const cards = listingsWithPhotos(rows, 4);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.length).toBeLessThanOrEqual(4);
    expect(cards.every((c) => /^https?:\/\//.test(c.imageUrl))).toBe(true);
    expect(cards.some((c) => c.storeName === "Target" && c.priceCents === 39999)).toBe(false);
  });

  it("fallback shop list keeps priced rows without photos (up to 4)", () => {
    const base = {
      currency: "USD" as const,
      availability: "in_stock" as const,
      availabilityLabel: "In Stock",
      productUrl: "https://example.com/x",
      shoppingCity: "",
      category: "electronics" as const,
    };
    const rows: ProductListing[] = [
      { ...base, listingId: "amazon:1", storeName: "Amazon", storeSlug: "amazon", productTitle: "USB-C Charger 25W", priceCents: 1599, imageUrl: "" },
      { ...base, listingId: "target:1", storeName: "Target", storeSlug: "target", productTitle: "USB-C Charger", priceCents: 1299, imageUrl: "" },
      { ...base, listingId: "walmart:1", storeName: "Walmart", storeSlug: "walmart", productTitle: "Anker USB-C Charger", priceCents: 1899, imageUrl: "" },
      { ...base, listingId: "apple:1", storeName: "Apple", storeSlug: "apple", productTitle: "USB-C Charge Cable", priceCents: 1900, imageUrl: "" },
    ];
    expect(listingsWithPhotos(rows, 4)).toHaveLength(0);
    const picks = listingsForPicker(rows, 4);
    expect(picks).toHaveLength(4);
    const list = formatShopPickList(picks);
    expect(list).toMatch(/^1\. /);
    expect(list).toMatch(/Amazon/);
    expect(list).toMatch(/\$15\.99/);
    expect(list).not.toMatch(/https?:\/\//);
  });
});

describe("from Amazon filters merchant", () => {
  it("keeps only that storeSlug", () => {
    const base = {
      currency: "USD" as const,
      availability: "in_stock" as const,
      availabilityLabel: "In Stock",
      productUrl: "https://example.com/x",
      shoppingCity: "",
      category: "electronics" as const,
      imageUrl: "https://cdn.example.com/a.jpg",
      priceCents: 1599,
      productTitle: "USB-C Charger",
    };
    const rows: ProductListing[] = [
      { ...base, listingId: "amazon:1", storeName: "Amazon", storeSlug: "amazon" },
      { ...base, listingId: "target:1", storeName: "Target", storeSlug: "target" },
    ];
    const amazon = listingsForMerchant(rows, "Amazon");
    expect(amazon).toHaveLength(1);
    expect(amazon[0]?.storeSlug).toBe("amazon");
    expect(listingsForMerchant(rows, "").map((l) => l.storeSlug)).toEqual(["amazon", "target"]);
  });
});

describe("pasted product URL metadata", () => {
  it("parses Open Graph title, image, and price", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Anker USB-C Charger" />
        <meta property="og:image" content="https://i.ebayimg.com/charger.jpg" />
        <meta property="og:price:amount" content="19.99" />
      </head></html>
    `;
    const meta = parseProductHtml(html, "https://www.ebay.com/itm/123");
    expect(meta.title).toBe("Anker USB-C Charger");
    expect(meta.imageUrl).toBe("https://i.ebayimg.com/charger.jpg");
    expect(meta.priceCents).toBe(1999);
    const listing = listingFromUrlMeta(meta);
    expect(listing?.productTitle).toBe("Anker USB-C Charger");
    expect(listing?.imageUrl).toBe("https://i.ebayimg.com/charger.jpg");
    expect(listing?.priceCents).toBe(1999);
  });
});
