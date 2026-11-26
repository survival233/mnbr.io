import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductListing } from "./types.js";
import { searchAllSources, shopifyMcpEnabled, type CatalogSource } from "./sources.js";

function listing(id: string): ProductListing {
  return {
    listingId: id,
    storeName: "Store",
    storeSlug: "link",
    productTitle: `Item ${id}`,
    priceCents: 1000,
    currency: "USD",
    availability: "in_stock",
    availabilityLabel: "In Stock",
    productUrl: `https://store.example/${id}`,
    imageUrl: "",
    shoppingCity: "",
    category: "electronics",
  };
}

function source(name: string, impl: () => Promise<ProductListing[]>): CatalogSource {
  return { name, enabled: () => true, search: impl };
}

afterEach(() => vi.unstubAllEnvs());

describe("searchAllSources", () => {
  const args = { query: "iphone" };

  it("merges listings from all sources, de-duping by listingId", async () => {
    const a = source("a", async () => [listing("x"), listing("y")]);
    const b = source("b", async () => [listing("y"), listing("z")]); // y is a dup
    const out = await searchAllSources(args, [a, b]);
    expect(out.map((l) => l.listingId)).toEqual(["x", "y", "z"]);
  });

  it("isolates a single source failure — the others still return", async () => {
    const good = source("good", async () => [listing("x")]);
    const bad = source("bad", async () => {
      throw new Error("boom");
    });
    const out = await searchAllSources(args, [good, bad]);
    expect(out.map((l) => l.listingId)).toEqual(["x"]);
  });

  it("re-throws when EVERY source fails (callers keep their error handling)", async () => {
    const bad = source("bad", async () => {
      throw new Error("no market");
    });
    await expect(searchAllSources(args, [bad])).rejects.toThrow(/no market/);
  });

  it("returns [] when there are no enabled sources", async () => {
    expect(await searchAllSources(args, [])).toEqual([]);
  });
});

describe("shopifyMcpEnabled", () => {
  it("is off by default and on only with the flag", () => {
    expect(shopifyMcpEnabled()).toBe(false);
    vi.stubEnv("CATALOG_SHOPIFY_MCP", "1");
    expect(shopifyMcpEnabled()).toBe(true);
  });
});
