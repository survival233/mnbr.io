/**
 * Resolve the EXACT approved-store product URL (and a product image) for a
 * selected listing, via SerpAPI's Google Product API.
 *
 * Why this exists: Google Shopping rows give a google.com product/redirect link,
 * not the store's page (in practice `link` is usually empty and `product_link`
 * is a google.com redirect). But the selected listing's `productUrl` is the item
 * link handed to the traveler once the shopping and traveler agents reach
 * consensus — the traveler buys from exactly that link. So it must be the real
 * approved-store page, never a Google redirect.
 *
 * Live response shape (verified against SerpAPI engine=google_product): the
 * per-merchant offers live at `product_results.stores[]`, each with a plain
 * `link` that is already the direct store URL (there is no `direct_link` field),
 * a `name`, and an `extracted_price`. Images are `product_results.thumbnails`
 * (a string array of Google-hosted thumbnails — there is no store-hosted image
 * in this response), so we keep the listing's existing image and only fall back
 * to a thumbnail when it has none. No image "upgrade" is claimed.
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

interface GoogleProductStore {
  name?: string;
  link?: string;
  extracted_price?: number;
}
interface GoogleProductResponse {
  error?: string;
  product_results?: {
    thumbnails?: string[];
    stores?: GoogleProductStore[];
  };
}

function domainsForSlug(slug: string): string[] {
  const store = VERIFIED_STORES.find((s) => s.slug === slug);
  return store ? store.domains.map((d) => d.replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase()) : [];
}

function firstThumbnail(data: GoogleProductResponse): string | undefined {
  const thumbs = data.product_results?.thumbnails ?? [];
  return thumbs.find((u) => /^https?:\/\//.test(u ?? ""));
}

/**
 * Return the listing upgraded to its exact store URL when a direct link from the
 * SAME approved store is found (the price-closest one, to avoid grabbing a
 * different variant); otherwise the listing with `urlVerified: false`; or
 * unchanged when disabled / no product id / on error.
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
    const stores = data.product_results?.stores ?? [];
    const image = listing.imageUrl || firstThumbnail(data) || "";

    let best: ProductListing | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const store of stores) {
      const url = (store.link || "").trim();
      if (!url) continue;
      const dom = registrableDomain(url);
      if (!dom || !approved.has(dom)) continue;
      // Keep store integrity: only accept the seller that is THIS listing's store.
      const sameStore =
        wantDomains.has(dom) || matchVerifiedStore(store.name ?? "", url)?.slug === listing.storeSlug;
      if (!sameStore) continue;
      // Among same-store entries, prefer the one priced closest to the selection.
      const cents = typeof store.extracted_price === "number" ? Math.round(store.extracted_price * 100) : null;
      const delta = cents == null ? Number.MAX_SAFE_INTEGER : Math.abs(cents - listing.priceCents);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = { ...listing, productUrl: url, urlVerified: true, imageUrl: image };
      }
    }
    if (best) return best;
    // No direct link from the listing's own approved store — leave the URL, flag it.
    return { ...listing, urlVerified: false };
  } catch {
    return listing;
  }
}
