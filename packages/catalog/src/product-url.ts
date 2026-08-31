/**
 * Pasted product URL → Open Graph / JSON-LD card.
 * Does not place a store order.
 */
import type { ProductListing } from "./types.js";
import { matchVerifiedStore } from "./verified-stores.js";
import { listingIdFor } from "./cache.js";

export type ProductUrlMeta = {
  title: string | null;
  imageUrl: string | null;
  priceCents: number | null;
  productUrl: string;
};

function attr(tag: string, name: string): string | null {
  const m =
    tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i")) ||
    tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return m?.[1]?.trim() || null;
}

function metaContent(html: string, keys: string[]): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const want = new Set(keys.map((k) => k.toLowerCase()));
  for (const tag of tags) {
    const prop = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (!want.has(prop)) continue;
    const content = attr(tag, "content");
    if (content) return content;
  }
  return null;
}

function parsePriceToCents(raw: string | number | undefined | null): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw * 100);
  }
  const m = String(raw).replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const dollars = Number(m[1]);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

function jsonLdProducts(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const data = JSON.parse(json);
      const nodes = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const n of nodes) {
        const type = String(n?.["@type"] ?? "");
        if (/product/i.test(type)) out.push(n);
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return out;
}

function firstImage(value: unknown): string | null {
  if (typeof value === "string" && value.startsWith("http")) return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const u = firstImage(v);
      if (u) return u;
    }
  }
  if (value && typeof value === "object" && "url" in (value as object)) {
    return firstImage((value as { url?: unknown }).url);
  }
  return null;
}

function offerPrice(product: Record<string, unknown>): number | null {
  const offers = product.offers as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  for (const o of list) {
    const cents = parsePriceToCents(o.price as string | number | undefined);
    if (cents) return cents;
  }
  return parsePriceToCents(product.price as string | number | undefined);
}

function hostnameLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const name = host.split(".")[0] ?? host;
    return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "Store";
  }
}

function titleFromPath(url: string): string | null {
  try {
    const path = decodeURIComponent(new URL(url).pathname).replace(/\/+/g, " ").trim();
    const last = path.split("/").filter(Boolean).pop() ?? "";
    const cleaned = last.replace(/[-_]+/g, " ").replace(/\.(html?|php)$/i, "").trim();
    if (cleaned.length < 3 || /^\d+$/.test(cleaned)) return null;
    return cleaned.slice(0, 80);
  } catch {
    return null;
  }
}

export function parseProductHtml(html: string, productUrl: string): ProductUrlMeta {
  const ld = jsonLdProducts(html)[0];
  const title =
    (typeof ld?.name === "string" ? ld.name : null) ||
    metaContent(html, ["og:title", "twitter:title"]) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ||
    null;
  const imageUrl =
    firstImage(ld?.image) ||
    metaContent(html, ["og:image", "og:image:url", "twitter:image"]) ||
    null;
  const priceCents =
    (ld ? offerPrice(ld) : null) ||
    parsePriceToCents(metaContent(html, ["og:price:amount", "product:price:amount", "twitter:data1"]));
  return {
    title: title?.replace(/\s+/g, " ").trim() || null,
    imageUrl: imageUrl?.startsWith("http") ? imageUrl : null,
    priceCents,
    productUrl,
  };
}

export async function fetchProductUrlMeta(url: string): Promise<ProductUrlMeta> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Manebra/1.0; +https://mnbr.io)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    const html = await res.text();
    return parseProductHtml(html.slice(0, 400_000), res.url || url);
  } finally {
    clearTimeout(timer);
  }
}

export function listingFromUrlMeta(meta: ProductUrlMeta): ProductListing | null {
  const title = meta.title?.trim();
  if (!title) return null;
  const store = matchVerifiedStore("", meta.productUrl);
  return {
    listingId: listingIdFor(store?.slug ?? "link", meta.productUrl),
    storeName: store?.name ?? hostnameLabel(meta.productUrl),
    storeSlug: store?.slug ?? "link",
    productTitle: title.slice(0, 160),
    priceCents: meta.priceCents ?? 0,
    currency: "USD",
    availability: "unknown",
    availabilityLabel: "See store",
    productUrl: meta.productUrl,
    imageUrl: meta.imageUrl ?? "",
    shoppingCity: "",
    category: "electronics",
  };
}

/** Fallback query when OG/JSON-LD has no usable title. */
export function productNameFromUrl(url: string): string | null {
  return titleFromPath(url);
}

export async function listingFromProductUrl(url: string): Promise<ProductListing | null> {
  try {
    const meta = await fetchProductUrlMeta(url);
    return listingFromUrlMeta(meta);
  } catch {
    return null;
  }
}
