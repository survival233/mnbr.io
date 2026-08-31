import type { ProductListing, ProductSearchResult } from "./types.js";
import { searchGoogleShoppingLive, hasSerpApiKey } from "./serp-shopping.js";
import { cacheListings, getCachedListing } from "./cache.js";
import { supportedShoppingCities } from "./verified-stores.js";
import { shopMarketForCity, NoShopMarketError } from "./markets.js";

export { supportedShoppingCities, hasSerpApiKey, shopMarketForCity, NoShopMarketError };

/**
 * Live product search across verified stores (Apple, Best Buy, Walmart, Target, Amazon).
 * Uses Google Shopping via SerpAPI — not each store's API, and not dummy data.
 */
export async function searchProducts(args: {
  query: string;
  shoppingCity: string;
}): Promise<ProductSearchResult> {
  const shoppingCity = args.shoppingCity.trim();
  const query = args.query.trim();
  if (!query || !shoppingCity) {
    return { query, shoppingCity, identifiedProduct: null, listings: [] };
  }

  const listings = await searchGoogleShoppingLive({ query, shoppingCity });
  cacheListings(listings);

  return {
    query,
    shoppingCity,
    identifiedProduct: listings[0]?.productTitle ?? null,
    listings,
  };
}

/** Resolve a listing the shopper selected from a recent live search. */
export function findListing(listingId: string, _shoppingCity?: string): ProductListing | null {
  return getCachedListing(listingId);
}
