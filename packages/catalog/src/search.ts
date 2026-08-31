import type { ProductListing, ProductSearchResult } from "./types.js";
import { searchGoogleShoppingLive, hasSerpApiKey } from "./serp-shopping.js";
import { cacheListings, getCachedListing } from "./cache.js";
import { supportedShoppingCities } from "./verified-stores.js";
import { shopMarketForCity, nationalShopMarket, NoShopMarketError } from "./markets.js";

export { supportedShoppingCities, hasSerpApiKey, shopMarketForCity, nationalShopMarket, NoShopMarketError };

/** Empty = national catalog. Never invent New York. */
export function catalogSearchCity(shoppingCity?: string | null): string {
  return shoppingCity?.trim() ?? "";
}

/**
 * Live product search across verified stores (Apple, Best Buy, Walmart, Target, Amazon).
 * Uses Google Shopping via SerpAPI — not each store's API, and not dummy data.
 * Catalog is national approved merchants; shoppingCity is optional and never defaults to a city.
 */
export async function searchProducts(args: {
  query: string;
  shoppingCity?: string;
}): Promise<ProductSearchResult> {
  const shoppingCity = catalogSearchCity(args.shoppingCity);
  const query = args.query.trim();
  if (!query) {
    return { query, shoppingCity, identifiedProduct: null, listings: [] };
  }

  const listings = await searchGoogleShoppingLive({
    query,
    shoppingCity: shoppingCity || undefined,
  });
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
