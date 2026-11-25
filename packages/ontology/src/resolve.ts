/**
 * Concept resolvers — turn messy shopper/traveler text into MNBR's canonical
 * terms before any agent acts on them (the "resolve" step borrowed from
 * NVIDIA Auto Ontology: ground words to governed concepts, don't let the model
 * guess). Pure string maps only; the truth they map ONTO lives in the owning
 * packages (@manebra/shared categories, @manebra/catalog stores), and the
 * governed lists there stay the source of truth.
 */
import { TRIP_DIRECTIONS, type TripDirection } from "@manebra/shared";

/** Canonical category slugs are owned by @manebra/shared/categories.ts. */
const CATEGORY_SYNONYMS: Record<string, readonly string[]> = {
  electronics: ["iphone", "phone", "smartphone", "laptop", "macbook", "airpods", "charger", "console", "camera", "gadget", "electronic", "electronics", "tablet", "ipad", "watch"],
  clothing_shoes: ["shoe", "shoes", "sneaker", "sneakers", "clothes", "clothing", "apparel", "jacket", "dress", "jeans", "shirt", "hoodie"],
  cosmetics_sealed: ["perfume", "cologne", "makeup", "cosmetic", "cosmetics", "cream", "lotion", "skincare", "fragrance", "lipstick"],
  books_media: ["book", "books", "dvd", "magazine", "media", "textbook"],
  food_sealed_nonperishable: ["snack", "snacks", "chocolate", "candy", "coffee", "sealed food", "cereal", "supplement", "supplements"],
  foodstuffs_cbp_permitted: ["gari", "shito", "spice", "spices", "groundnut", "foodstuff", "foodstuffs", "dried"],
  textiles_kente: ["kente", "cloth", "fabric", "textile", "textiles", "ankara"],
  crafts_nonrestricted: ["craft", "crafts", "carving", "beads", "handicraft", "art", "sculpture"],
};

/** Common store names/brands → their domain. The payability check still runs later. */
const MERCHANT_SYNONYMS: Record<string, readonly string[]> = {
  "apple.com": ["apple", "apple store", "the apple store"],
  "amazon.com": ["amazon", "amzn"],
  "target.com": ["target"],
  "walmart.com": ["walmart"],
  "bestbuy.com": ["best buy", "bestbuy"],
  "sephora.com": ["sephora"],
  "nike.com": ["nike"],
  "costco.com": ["costco"],
};

/** The country tokens MNBR serves today, mapped to ISO-ish codes. */
const COUNTRY_SYNONYMS: Record<string, readonly string[]> = {
  US: ["us", "u.s.", "u.s.a", "usa", "america", "the states", "united states", "new york", "nyc", "jersey", "new jersey"],
  GH: ["gh", "ghana", "accra", "kumasi", "tema"],
};

function firstMatch(text: string, table: Record<string, readonly string[]>): string | null {
  const t = text.toLowerCase();
  for (const [canonical, syns] of Object.entries(table)) {
    if (syns.some((s) => t.includes(s))) return canonical;
  }
  return null;
}

/** Resolve a free-text item hint to a canonical compliance category, or null. */
export function resolveCategory(text: string): string | null {
  return firstMatch(text, CATEGORY_SYNONYMS);
}

/** Resolve a store name/brand to a domain, or null when unknown. */
export function resolveMerchant(text: string): string | null {
  return firstMatch(text, MERCHANT_SYNONYMS);
}

/** Resolve a place/country mention to a served country code, or null. */
export function resolveCountry(text: string): "US" | "GH" | null {
  const hit = firstMatch(text, COUNTRY_SYNONYMS);
  return hit === "US" || hit === "GH" ? hit : null;
}

/** Build a canonical corridor from origin+destination countries, or null. */
export function resolveCorridor(
  origin: "US" | "GH" | null,
  destination: "US" | "GH" | null,
): TripDirection | null {
  if (!origin || !destination || origin === destination) return null;
  const dir = `${origin.toLowerCase()}_to_${destination.toLowerCase()}` as TripDirection;
  return TRIP_DIRECTIONS.includes(dir) ? dir : null;
}
