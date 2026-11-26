/**
 * Multi-source product discovery. Today the big-box / long-tail catalog comes
 * from SerpAPI (Google Shopping); this seam lets other sources — notably
 * Shopify's One MCP / Catalog API (Fall 2026 agentic rails) for DTC/Shopify
 * merchants — plug in behind one interface, all feeding the same trusted-listing
 * pipeline (filter + exact-store-URL resolution). Discovery is enabling tech;
 * MNBR's moat stays the traveler network + cross-border escrow/trust.
 */
import type { ProductListing } from "./types.js";
import { searchGoogleShoppingLive } from "./serp-shopping.js";

export interface CatalogSearchArgs {
  query: string;
  shoppingCity?: string;
  limit?: number;
}

export interface CatalogSource {
  readonly name: string;
  /** Whether this source is configured/turned on. */
  enabled(): boolean;
  /** Return listings for the query. May throw; aggregation isolates failures. */
  search(args: CatalogSearchArgs): Promise<ProductListing[]>;
}

/**
 * Google Shopping via SerpAPI — the big-box + long-tail source. Always present;
 * it throws a clear "requires SERPAPI_API_KEY" error when no key is configured,
 * which aggregation surfaces to the caller (callers guard on hasSerpApiKey).
 */
export const serpCatalogSource: CatalogSource = {
  name: "serpapi",
  enabled: () => true,
  search: (args) => searchGoogleShoppingLive(args),
};

/** On only with the flag set (Shopify discovery is opt-in until wired up). */
export function shopifyMcpEnabled(): boolean {
  const v = process.env.CATALOG_SHOPIFY_MCP?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/**
 * Placeholder for a Shopify Catalog / One MCP discovery source. NOT implemented:
 * when shop.dev access + docs are in hand, call One MCP / the Catalog API
 * (search_catalog / get_product) here and map results into ProductListing
 * (listingId, storeName/slug, productTitle, priceCents, productUrl, imageUrl…)
 * so they flow through the same filter + resolveDirectStoreUrl pipeline. Flag-
 * guarded by CATALOG_SHOPIFY_MCP; returns [] so enabling it never breaks search.
 */
export const shopifyMcpCatalogSource: CatalogSource = {
  name: "shopify-mcp",
  enabled: () => shopifyMcpEnabled(),
  async search(_args: CatalogSearchArgs): Promise<ProductListing[]> {
    return [];
  },
};

/** The enabled discovery sources, in priority order. */
export function catalogSources(): CatalogSource[] {
  return [serpCatalogSource, shopifyMcpCatalogSource].filter((s) => s.enabled());
}

/**
 * Query every enabled source and merge, de-duping by listingId. A single source
 * failing is isolated — the others still return. If EVERY source fails, the
 * first error is re-thrown so callers keep their existing error handling (e.g.
 * NoShopMarketError, SerpAPI failures).
 */
export async function searchAllSources(
  args: CatalogSearchArgs,
  sources: CatalogSource[] = catalogSources(),
): Promise<ProductListing[]> {
  if (!sources.length) return [];
  const results = await Promise.allSettled(sources.map((s) => s.search(args)));
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected.length === sources.length) {
    throw rejected[0]!.reason;
  }
  const merged: ProductListing[] = [];
  const seen = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn(`[catalog] source ${sources[i]?.name} failed: ${r.reason?.message ?? r.reason}`);
      return;
    }
    for (const l of r.value) {
      if (!l?.listingId || seen.has(l.listingId)) continue;
      seen.add(l.listingId);
      merged.push(l);
    }
  });
  return merged;
}
