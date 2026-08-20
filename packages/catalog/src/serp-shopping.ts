/**
 * Live Google Shopping via SerpAPI — one key, many verified stores.
 * No Apple / Best Buy / Walmart developer APIs. No scraping of store HTML.
 * https://serpapi.com/google-shopping-api
 */
import type { ProductListing } from "./types.js";
import { matchVerifiedStore } from "./verified-stores.js";
import { listingIdFor } from "./cache.js";
import { shopMarketForCity, NoShopMarketError } from "./markets.js";

export function hasSerpApiKey(): boolean {
  return Boolean(process.env.SERPAPI_API_KEY?.trim());
}

function parsePriceToCents(price: string | number | undefined): number | null {
  if (price == null) return null;
  if (typeof price === "number" && Number.isFinite(price) && price > 0) {
    return Math.round(price * 100);
  }
  const m = String(price).replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const dollars = Number(m[1]);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

function inferCategory(query: string, title: string): ProductListing["category"] {
  const t = `${query} ${title}`.toLowerCase();
  if (/iphone|ipad|macbook|airpods|laptop|phone|tv|headphone|camera|console|xbox|playstation/.test(t)) {
    return "electronics";
  }
  if (/shoe|sneaker|shirt|dress|jacket|clothing|nike|adidas/.test(t)) return "clothing_shoes";
  if (/cosmetic|makeup|serum|skincare|perfume/.test(t)) return "cosmetics_sealed";
  if (/book|kindle|dvd|blu-ray|media/.test(t)) return "books_media";
  if (/food|snack|grocery|coffee/.test(t)) return "food_sealed_nonperishable";
  return "electronics";
}

function availabilityFrom(raw: string | undefined): Pick<ProductListing, "availability" | "availabilityLabel"> {
  const t = (raw ?? "").toLowerCase();
  if (/out of stock|unavailable|sold out/.test(t)) {
    return { availability: "out_of_stock", availabilityLabel: "Out of Stock" };
  }
  if (/pickup/.test(t)) return { availability: "pickup_today", availabilityLabel: raw || "Pickup" };
  if (/in stock|available/.test(t)) return { availability: "in_stock", availabilityLabel: raw || "In Stock" };
  if (raw) return { availability: "unknown", availabilityLabel: raw };
  return { availability: "unknown", availabilityLabel: "See store" };
}

interface SerpShoppingItem {
  title?: string;
  source?: string;
  price?: string;
  extracted_price?: number;
  link?: string;
  product_link?: string;
  thumbnail?: string;
  extensions?: string[];
  delivery?: string;
}

export async function searchGoogleShoppingLive(args: {
  query: string;
  shoppingCity: string;
  limit?: number;
}): Promise<ProductListing[]> {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Live product search requires SERPAPI_API_KEY (Google Shopping aggregator — not store APIs). " +
        "Get a key at https://serpapi.com and add it to apps/agent-cli/.env or your process env.",
    );
  }

  const market = shopMarketForCity(args.shoppingCity);
  if (!market) throw new NoShopMarketError(args.shoppingCity);

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: args.query,
    api_key: apiKey,
    hl: "en",
    gl: market.gl,
    num: "40",
    location: `${args.shoppingCity}, ${market.locationCountry}`,
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) {
    throw new Error(`SerpAPI Google Shopping ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    error?: string;
    shopping_results?: SerpShoppingItem[];
  };
  if (data.error) throw new Error(`SerpAPI: ${data.error}`);

  const bestByStore = new Map<string, ProductListing>();
  for (const item of data.shopping_results ?? []) {
    const url = item.link || item.product_link;
    if (!url || !item.title) continue;
    const store = matchVerifiedStore(item.source ?? "", url);
    if (!store) continue;
    const priceCents = parsePriceToCents(item.extracted_price ?? item.price);
    if (priceCents == null) continue;
    const ext = [...(item.extensions ?? []), item.delivery ?? ""].filter(Boolean).join(" ");
    const avail = availabilityFrom(ext);
    const listing: ProductListing = {
      listingId: listingIdFor(store.slug, url),
      storeName: store.name,
      storeSlug: store.slug,
      productTitle: item.title,
      priceCents,
      currency: market.currency,
      availability: avail.availability,
      availabilityLabel: avail.availabilityLabel,
      productUrl: url,
      imageUrl: item.thumbnail || "",
      shoppingCity: args.shoppingCity,
      category: inferCategory(args.query, item.title),
    };
    const prev = bestByStore.get(store.slug);
    if (!prev || listing.priceCents < prev.priceCents) bestByStore.set(store.slug, listing);
  }

  return [...bestByStore.values()]
    .filter((l) => l.availability !== "out_of_stock")
    .sort((a, b) => a.priceCents - b.priceCents)
    .slice(0, args.limit ?? 10);
}
