import { describe, expect, it } from "vitest";
import type { ProductListing } from "./types.js";
import {
  classifySearchQuery,
  filterCatalogListings,
  merchantDomainAllowed,
  normalizeListing,
  registrableDomain,
  resolveListingPick,
} from "./quality.js";

function listing(
  partial: Partial<ProductListing> &
    Pick<ProductListing, "listingId" | "storeSlug" | "productTitle" | "priceCents" | "productUrl">,
): ProductListing {
  return {
    storeName: partial.storeName ?? "Amazon",
    currency: "USD",
    availability: "in_stock",
    availabilityLabel: "In Stock",
    imageUrl: partial.imageUrl ?? "https://cdn.example.com/p.jpg",
    shoppingCity: "",
    category: "electronics",
    ...partial,
  };
}

describe("classifySearchQuery", () => {
  it("uses word boundaries for device vs accessory vs unknown", () => {
    expect(classifySearchQuery("iphone")).toBe("device");
    expect(classifySearchQuery("iphone case")).toBe("accessory");
    expect(classifySearchQuery("hoodie")).toBe("unknown");
  });
});

describe("condition — title only, unused ≠ used", () => {
  it("drops refurbished/used on title and keeps unused", () => {
    const rows = [
      listing({
        listingId: "amazon:new",
        storeSlug: "amazon",
        storeName: "Amazon",
        productTitle: "Apple iPhone 15 128GB",
        priceCents: 79_900,
        productUrl: "https://www.amazon.com/iphone",
      }),
      listing({
        listingId: "amazon:used",
        storeSlug: "amazon",
        storeName: "Amazon",
        productTitle: "Used Apple iPhone 15 128GB",
        priceCents: 49_900,
        productUrl: "https://www.amazon.com/used-iphone",
      }),
      listing({
        listingId: "amazon:unused",
        storeSlug: "amazon",
        storeName: "Amazon",
        productTitle: "Brand new unused iPhone 15 128GB",
        priceCents: 79_900,
        productUrl: "https://www.amazon.com/unused-iphone",
      }),
    ];
    const { listings, drops } = filterCatalogListings(rows, "iphone");
    expect(drops.some((d) => d.reason === "condition" && /used apple/i.test(d.listing.productTitle))).toBe(true);
    expect(listings.some((l) => /unused/i.test(l.productTitle))).toBe(true);
    expect(listings.some((l) => /^used\b/i.test(l.productTitle))).toBe(false);
  });
});

describe("device vs accessory price and titles", () => {
  it("iphone device query has no sub-$400 phones and no cases", () => {
    const rows = [
      listing({
        listingId: "amazon:cheap",
        storeSlug: "amazon",
        productTitle: "Apple iPhone 12",
        priceCents: 19_900,
        productUrl: "https://www.amazon.com/cheap-iphone",
      }),
      listing({
        listingId: "amazon:ok",
        storeSlug: "amazon",
        productTitle: "Apple iPhone 15 128GB",
        priceCents: 79_900,
        productUrl: "https://www.amazon.com/iphone-15",
      }),
      listing({
        listingId: "amazon:case",
        storeSlug: "amazon",
        productTitle: "Case for iPhone 15",
        priceCents: 3_499,
        productUrl: "https://www.amazon.com/iphone-case",
      }),
    ];
    const { listings, drops } = filterCatalogListings(rows, "iphone");
    expect(listings.every((l) => l.priceCents >= 40_000)).toBe(true);
    expect(listings.some((l) => /case/i.test(l.productTitle))).toBe(false);
    expect(drops.some((d) => d.reason === "price")).toBe(true);
    expect(drops.some((d) => d.reason === "accessory")).toBe(true);
  });

  it("iphone case query allows ~$35", () => {
    const rows = [
      listing({
        listingId: "amazon:case35",
        storeSlug: "amazon",
        productTitle: "Silicone Case for iPhone 15",
        priceCents: 3_500,
        productUrl: "https://www.amazon.com/case-35",
      }),
    ];
    const { listings } = filterCatalogListings(rows, "iphone case");
    expect(listings).toHaveLength(1);
    expect(listings[0]?.priceCents).toBe(3_500);
  });

  it("does not widen a laptop floor to pass a $34 MacBook", () => {
    const rows = [
      listing({
        listingId: "amazon:mbp34",
        storeSlug: "amazon",
        productTitle: "Apple MacBook Pro",
        priceCents: 3_400,
        productUrl: "https://www.amazon.com/macbook-34",
      }),
    ];
    const { listings, drops } = filterCatalogListings(rows, "macbook");
    expect(listings).toHaveLength(0);
    expect(drops[0]?.reason).toBe("price");
  });
});

describe("merchant domain allowlist", () => {
  it("allows walmart.com and rejects notwalmart.com", () => {
    expect(registrableDomain("https://www.walmart.com/ip/1")).toBe("walmart.com");
    expect(registrableDomain("https://notwalmart.com/ip/1")).toBe("notwalmart.com");
    expect(merchantDomainAllowed("https://www.walmart.com/ip/1")).toBe(true);
    expect(merchantDomainAllowed("https://notwalmart.com/ip/1")).toBe(false);
    const rows = [
      listing({
        listingId: "fake:1",
        storeSlug: "walmart",
        storeName: "Walmart",
        productTitle: "Apple iPhone 15 128GB",
        priceCents: 79_900,
        productUrl: "https://notwalmart.com/iphone",
      }),
    ];
    const { listings, drops } = filterCatalogListings(rows, "iphone");
    expect(listings).toHaveLength(0);
    expect(drops[0]?.reason).toBe("merchant");
  });
});

describe("variants nest by normalized name + merchant", () => {
  it("nests color/storage at the same store and keeps Walmart vs Target", () => {
    const rows = [
      listing({
        listingId: "amazon:pink",
        storeSlug: "amazon",
        storeName: "Amazon",
        productTitle: "Apple iPhone 15 Pro Max Pink 256GB",
        priceCents: 119_900,
        productUrl: "https://www.amazon.com/pink",
      }),
      listing({
        listingId: "amazon:blue",
        storeSlug: "amazon",
        storeName: "Amazon",
        productTitle: "Apple iPhone 15 Pro Max Pink 512GB",
        priceCents: 129_900,
        productUrl: "https://www.amazon.com/pink-512",
      }),
      listing({
        listingId: "target:pink",
        storeSlug: "target",
        storeName: "Target",
        productTitle: "Apple iPhone 15 Pro Max Pink 256GB",
        priceCents: 119_900,
        productUrl: "https://www.target.com/pink",
      }),
    ];
    const { listings } = filterCatalogListings(rows, "iphone");
    const amazon = listings.find((l) => l.storeSlug === "amazon");
    const target = listings.find((l) => l.storeSlug === "target");
    expect(amazon?.variants?.length).toBe(1);
    expect(target).toBeTruthy();
    expect(target?.variants ?? []).toHaveLength(0);
    const picked = resolveListingPick(amazon!, "pink 512GB");
    expect(picked.storage).toMatch(/512/i);
    expect(picked.priceCents).toBe(129_900);
  });
});

describe("normalizeListing", () => {
  it("keeps integer cents and ISO currency", () => {
    const n = normalizeListing(
      listing({
        listingId: "amazon:1",
        storeSlug: "amazon",
        productTitle: "iPhone 15",
        priceCents: 79900.4,
        currency: "usd",
        productUrl: "https://www.amazon.com/x",
      }),
    );
    expect(n.priceCents).toBe(79900);
    expect(n.currency).toBe("USD");
  });
});
