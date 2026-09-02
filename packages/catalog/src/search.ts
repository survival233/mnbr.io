import type { ProductListing, ProductSearchResult } from "./types.js";
import { searchGoogleShoppingLive, hasSerpApiKey } from "./serp-shopping.js";
import { cacheListings, getCachedListing } from "./cache.js";
import { supportedShoppingCities, matchVerifiedStore } from "./verified-stores.js";
import { shopMarketForCity, nationalShopMarket, NoShopMarketError } from "./markets.js";
import {
  classifySearchQuery,
  filterCatalogListings,
  flattenCatalogListings,
  merchantDomainAllowed,
  normalizeListing,
  registrableDomain,
} from "./quality.js";

export { supportedShoppingCities, hasSerpApiKey, shopMarketForCity, nationalShopMarket, NoShopMarketError };
export {
  classifySearchQuery,
  filterCatalogListings,
  flattenCatalogListings,
  normalizeListing,
  resolveListingPick,
} from "./quality.js";
export type { SearchQueryKind, FilterDropReason, FilterDrop } from "./quality.js";

/** Empty = national catalog. Never invent New York. */
export function catalogSearchCity(shoppingCity?: string | null): string {
  return shoppingCity?.trim() ?? "";
}

/**
 * Live product search across verified stores (Apple, Best Buy, Walmart, Target, Amazon).
 * Uses Google Shopping via SerpAPI — not each store's API, and not dummy data.
 * Catalog is national approved merchants; shoppingCity is optional and never defaults to a city.
 * Classify → existing HTTP (unchanged) → normalize → filter.
 */
export async function searchProducts(args: {
  query: string;
  shoppingCity?: string;
  merchant?: string;
}): Promise<ProductSearchResult> {
  const shoppingCity = catalogSearchCity(args.shoppingCity);
  const query = args.query.trim();
  if (!query) {
    return { query, shoppingCity, identifiedProduct: null, listings: [] };
  }
  const queryKind = classifySearchQuery(query);

  const listings = listingsForMerchant(
    await searchGoogleShoppingLive({
      query,
      shoppingCity: shoppingCity || undefined,
    }),
    args.merchant,
  );
  const { listings: filtered, drops } = filterCatalogListings(
    listings.map(normalizeListing),
    query,
    queryKind,
  );
  // #region agent log
  {
    const reasonCounts: Record<string, number> = {};
    for (const d of drops) reasonCounts[d.reason] = (reasonCounts[d.reason] ?? 0) + 1;
    const payload = {
      sessionId: "ee46bb",
      runId: "pre-fix",
      hypothesisId: "A",
      location: "packages/catalog/src/search.ts:searchProducts",
      message: "catalog wrap after HTTP",
      data: {
        query,
        queryKind,
        merchant: args.merchant ?? null,
        rawCount: listings.length,
        filteredCount: filtered.length,
        reasonCounts,
        samples: listings.slice(0, 8).map((l) => ({
          slug: l.storeSlug,
          host: registrableDomain(l.productUrl),
          merchantOk: merchantDomainAllowed(l.productUrl),
          priceCents: l.priceCents,
          title: (l.productTitle ?? "").slice(0, 72),
        })),
      },
      timestamp: Date.now(),
    };
    fetch("http://127.0.0.1:7792/ingest/af7dba43-916f-44eb-8996-041bf3055f0c", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ee46bb" },
      body: JSON.stringify(payload),
    }).catch(() => {});
    console.warn("[catalog-debug]", JSON.stringify({ rawCount: listings.length, filteredCount: filtered.length, reasonCounts, queryKind }));
  }
  // #endregion
  cacheListings(flattenCatalogListings(filtered));

  return {
    query,
    shoppingCity,
    identifiedProduct: filtered[0]?.productTitle ?? null,
    listings: filtered,
  };
}

/** Keep rows for a named merchant (“from Amazon”). Unknown names leave the list as-is. */
export function listingsForMerchant(
  listings: ProductListing[],
  merchant?: string | null,
): ProductListing[] {
  if (!merchant?.trim()) return listings;
  const hit = matchVerifiedStore(merchant);
  if (!hit) return listings;
  return listings.filter((l) => l.storeSlug === hit.slug);
}

/** Resolve a listing the shopper selected from a recent live search. */
export function findListing(listingId: string, _shoppingCity?: string): ProductListing | null {
  return getCachedListing(listingId);
}
