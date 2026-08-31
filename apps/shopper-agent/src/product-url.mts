import type { ProductListing } from "@manebra/catalog";
import { matchVerifiedStore, listingIdFor } from "@manebra/catalog";
import { taxCentsFor } from "@manebra/dialog";

export function extractHttpUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  return m[0]!.replace(/[),.;!?]+$/g, "");
}

function attr(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  const m = html.match(re);
  if (m?.[1]) return decodeHtml(m[1]);
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
    "i",
  );
  const m2 = html.match(re2);
  return m2?.[1] ? decodeHtml(m2[1]) : null;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parsePriceToCents(raw: string | number | undefined | null): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw * 100);
  const m = String(raw).replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const dollars = Number(m[1]);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

function asStringArray(v: unknown): string[] {
  if (typeof v === "string" && v.startsWith("http")) return [v];
  if (Array.isArray(v)) return v.flatMap(asStringArray);
  if (v && typeof v === "object" && "url" in (v as object)) return asStringArray((v as { url?: unknown }).url);
  return [];
}

function fromJsonLd(html: string): { title?: string; image?: string; priceCents?: number; merchant?: string } {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try {
      const json = JSON.parse(b[1]!.trim());
      const nodes = Array.isArray(json) ? json : json?.["@graph"] ? json["@graph"] : [json];
      for (const node of nodes) {
        const type = String(node?.["@type"] ?? "");
        if (!/product/i.test(type)) continue;
        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const img = asStringArray(node.image)[0];
        const price = parsePriceToCents(offer?.price ?? offer?.lowPrice ?? node.price);
        const merchant = offer?.seller?.name ?? node.brand?.name ?? node.brand;
        return {
          title: typeof node.name === "string" ? node.name : undefined,
          image: img,
          priceCents: price ?? undefined,
          merchant: typeof merchant === "string" ? merchant : undefined,
        };
      }
    } catch {
      /* skip bad JSON-LD */
    }
  }
  return {};
}

/**
 * Fetch og:image / JSON-LD for a pasted store URL. Does not place an order.
 */
export async function listingFromProductUrl(url: string): Promise<ProductListing | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 MANEBRA" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ld = fromJsonLd(html);
    const image = attr(html, "og:image") ?? attr(html, "og:image:url") ?? ld.image ?? "";
    const title =
      attr(html, "og:title") ?? ld.title ?? attr(html, "twitter:title") ?? "";
    const priceCents =
      parsePriceToCents(attr(html, "og:price:amount") ?? attr(html, "product:price:amount")) ??
      ld.priceCents ??
      null;
    const store = matchVerifiedStore(ld.merchant ?? attr(html, "og:site_name") ?? "", url);
    if (!title.trim() || !store || priceCents == null) return null;
    const listing: ProductListing = {
      listingId: listingIdFor(store.slug, url),
      storeName: store.name,
      storeSlug: store.slug,
      productTitle: title.trim().slice(0, 120),
      priceCents,
      taxCents: taxCentsFor({ priceCents, storeName: store.name }),
      currency: "USD",
      availability: "unknown",
      availabilityLabel: "See store",
      productUrl: url,
      imageUrl: image.startsWith("http") ? image : "",
      shoppingCity: "United States",
      category: "electronics",
    };
    return listing;
  } catch (e: any) {
    console.warn(`[shopper-agent] product URL fetch failed: ${e?.message ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
