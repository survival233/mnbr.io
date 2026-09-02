import type { ProductListing, ProductSearchResult } from "./types.js";
import { searchGoogleShoppingLive, hasSerpApiKey } from "./serp-shopping.js";
import { cacheListings, getCachedListing } from "./cache.js";
import { supportedShoppingCities, matchVerifiedStore } from "./verified-stores.js";
import { shopMarketForCity, nationalShopMarket, NoShopMarketError } from "./markets.js";
import {
  classifySearchQuery,
  filterCatalogListings,
  flattenCatalogListings,
  normalizeListing,
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
  const filtered = filterCatalogListings(listings.map(normalizeListing), query, queryKind).listings;
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
