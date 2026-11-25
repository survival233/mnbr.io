/**
 * Resolve the EXACT approved-store product URL (and the store's own image) for a
 * selected listing, via SerpAPI's Google Product API.
 *
 * Why this exists: Google Shopping rows give a google.com product/redirect link,
 * not the store's page. But the selected listing's `productUrl` is the item link
 * handed to the traveler once the shopping and traveler agents reach consensus —
 * the traveler buys from exactly that link. So it must be the real approved-store
 * page, never a Google redirect.
 *
 * Cost: one extra SerpAPI call per selection (not per search result), so it runs
 * only when CATALOG_RESOLVE_DIRECT_URL is on and only at selection time. It is
 * fallback-safe: on any failure it returns the listing unchanged, so selection
 * never breaks — it just stays `urlVerified: false/undefined`.
 */
import type { ProductListing } from "./types.js";
import { VERIFIED_STORES, matchVerifiedStore } from "./verified-stores.js";
import { registrableDomain, allowedMerchantDomains } from "./quality.js";

/** On only when the flag is set AND a SerpAPI key is present. */
export function directStoreUrlsEnabled(): boolean {
  const v = process.env.CATALOG_RESOLVE_DIRECT_URL?.trim().toLowerCase();
  return (v === "1" || v === "true" || v === "on") && Boolean(process.env.SERPAPI_API_KEY?.trim());
}

interface GoogleProductSeller {
  name?: string;
  link?: string;
  direct_link?: string;
}
interface GoogleProductResponse {
  error?: string;
  product_results?: { media?: { type?: string; link?: string }[] };
  sellers_results?: { online_sellers?: GoogleProductSeller[] };
}

function domainsForSlug(slug: string): string[] {
  const store = VERIFIED_STORES.find((s) => s.slug === slug);
  return store ? store.domains.map((d) => d.replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase()) : [];
}

function firstImage(data: GoogleProductResponse): string | undefined {
  const media = data.product_results?.media ?? [];
  const hit = media.find((m) => m.type === "image" && /^https?:\/\//.test(m.link ?? ""));
  return hit?.link;
}

/**
 * Return the listing upgraded to its exact store URL + image when a direct link
 * from the SAME approved store is found; otherwise the listing with
 * `urlVerified: false`; or unchanged when disabled / no product id / on error.
 */
export async function resolveDirectStoreUrl(listing: ProductListing): Promise<ProductListing> {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey || !listing.productId) return listing;
  try {
    const params = new URLSearchParams({
      engine: "google_product",
      product_id: listing.productId,
      api_key: apiKey,
      gl: "us",
      hl: "en",
    });
    const res = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!res.ok) return listing;
    const data = (await res.json()) as GoogleProductResponse;
    if (data.error) return listing;

    const approved = new Set(allowedMerchantDomains());
    const wantDomains = new Set(domainsForSlug(listing.storeSlug));
    const sellers = data.sellers_results?.online_sellers ?? [];

    for (const seller of sellers) {
      const url = (seller.direct_link || seller.link || "").trim();
      if (!url) continue;
      const dom = registrableDomain(url);
      if (!dom || !approved.has(dom)) continue;
      // Keep store integrity: only accept the seller that is THIS listing's store.
      const sameStore =
        wantDomains.has(dom) || matchVerifiedStore(seller.name ?? "", url)?.slug === listing.storeSlug;
      if (!sameStore) continue;
      return { ...listing, productUrl: url, urlVerified: true, imageUrl: firstImage(data) || listing.imageUrl };
    }
    // No direct link from the listing's own approved store — leave the URL, flag it.
    return { ...listing, urlVerified: false };
  } catch {
    return listing;
  }
}
