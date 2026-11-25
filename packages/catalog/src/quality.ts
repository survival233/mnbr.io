/**
 * Source-agnostic catalog quality: classify → normalize → filter.
 * Does not know SerpAPI vs scrape. Does not perform HTTP.
 */
import type { ProductListing } from "./types.js";
import { VERIFIED_STORES } from "./verified-stores.js";

export type SearchQueryKind = "device" | "accessory" | "unknown";
export type PriceCategory = "phones" | "laptops" | "tablets" | "audio" | "other";
export type FilterDropReason = "condition" | "accessory" | "price" | "merchant" | "relevance" | "cap";

export type FilterDrop = { listing: ProductListing; reason: FilterDropReason };

const CONDITION =
  /\b(refurbished|used|open[-\s]?box|pre[-\s]?owned|renewed|reconditioned)\b/i;

const ACCESSORY_TITLE =
  /\b(cases?|cover|charger|cable|cord|screen\s*protectors?|folio|sleeve|skin|tempered\s*glass|adapter|dongle|lanyard)\b/i;

const ACCESSORY_QUERY =
  /\b(cases?|cover|charger|cable|cord|screen\s*protectors?|folio|sleeve|skin|tempered\s*glass|adapter|dongle)\b/i;

const DEVICE_QUERY =
  /\b(iphones?|ipads?|macbooks?|pixels?|galaxy|airpods?|ipods?|watch|watches|laptops?|tablets?|phones?|headphones?|earbuds?|mac\s*book)\b/i;

const COLORS = [
  "midnight",
  "starlight",
  "titanium",
  "natural",
  "graphite",
  "sierra",
  "pink",
  "blue",
  "black",
  "white",
  "gold",
  "silver",
  "purple",
  "green",
  "yellow",
  "orange",
  "gray",
  "grey",
  "navy",
  "beige",
  "red",
] as const;

/** Cents floors/ceilings by QUERY kind + category. Never widen to pass a test. */
const DEVICE_RANGE: Record<Exclude<PriceCategory, "other">, { min: number; max: number }> = {
  phones: { min: 40_000, max: 250_000 },
  laptops: { min: 40_000, max: 500_000 },
  tablets: { min: 20_000, max: 250_000 },
  audio: { min: 3_000, max: 100_000 },
};

const ACCESSORY_RANGE = { min: 100, max: 20_000 };

export function classifySearchQuery(query: string): SearchQueryKind {
  const q = (query ?? "").trim();
  if (!q) return "unknown";
  if (ACCESSORY_QUERY.test(q)) return "accessory";
  if (DEVICE_QUERY.test(q)) return "device";
  return "unknown";
}

export function priceCategoryForQuery(query: string): PriceCategory {
  const q = (query ?? "").toLowerCase();
  if (/\b(iphones?|pixels?|galaxy|\bphones?)\b/.test(q) && !/\b(headphone|earbud|airpods?)\b/.test(q)) {
    return "phones";
  }
  if (/\b(macbooks?|mac\s*book|laptops?|chromebook)\b/.test(q)) return "laptops";
  if (/\b(ipads?|tablets?)\b/.test(q)) return "tablets";
  if (/\b(airpods?|headphones?|earbuds?|earphones?)\b/.test(q)) return "audio";
  return "other";
}

export function allowedMerchantDomains(): string[] {
  const out = new Set<string>();
  for (const store of VERIFIED_STORES) {
    for (const d of store.domains) {
      const host = d
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, "")
        .replace(/^www\./i, "")
        .toLowerCase();
      const parts = host.split(".").filter(Boolean);
      if (parts.length >= 2) out.add(parts.slice(-2).join("."));
    }
  }
  return [...out];
}

/** Registrable domain (walmart.com). notwalmart.com is a different name. */
export function registrableDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return null;
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

export function merchantDomainAllowed(url: string): boolean {
  const got = registrableDomain(url);
  if (!got) return false;
  return allowedMerchantDomains().includes(got);
}

const SERP_REDIRECT_DOMAINS = new Set(["google.com", "googleadservices.com"]);

/**
 * Serp shopping rows are already matched to a verified store by source name,
 * but `link` is often google.com. Trust that storeSlug; still reject notwalmart.com.
 */
export function listingMerchantAllowed(listing: ProductListing): boolean {
  const host = registrableDomain(listing.productUrl);
  if (!host) return false;
  if (allowedMerchantDomains().includes(host)) return true;
  return (
    SERP_REDIRECT_DOMAINS.has(host) &&
    VERIFIED_STORES.some((s) => s.slug === listing.storeSlug)
  );
}

export function extractListingVariants(title: string): {
  color?: string;
  storage?: string;
  size?: string;
} {
  const t = title ?? "";
  const storage = t.match(/\b(\d+\s*(?:gb|tb))\b/i)?.[1]?.replace(/\s+/g, "").toUpperCase();
  let color: string | undefined;
  for (const c of COLORS) {
    if (new RegExp(`\\b${c}\\b`, "i").test(t)) {
      color = c;
      break;
    }
  }
  const size = t.match(/\b(xxx?l|xxl|xl|xxs|xs)\b/i)?.[1]?.toUpperCase();
  return { color, storage, size };
}

/**
 * Relevance gate — the listing's title must contain every distinctive thing the
 * shopper asked for, so a query never surfaces a different product (e.g.
 * "iphone 18 pro max" must not return an iPhone 15). This is the trust guard:
 * exact listing, not the aggregator's nearest match.
 *
 * Filler words are dropped, and COLOR and STORAGE tokens are excluded from the
 * requirement because those are variant choices the shopper picks downstream
 * (nestVariants groups them); the model identity — brand, line, generation and
 * modifiers like "pro"/"max" — must all be present.
 */
const QUERY_FILLER = new Set([
  "a", "an", "the", "new", "brand", "latest", "please", "pls", "plz", "me", "my", "mine",
  "find", "get", "buy", "order", "purchase", "want", "need", "looking", "show", "show me",
  "for", "from", "in", "at", "on", "some", "any", "one", "to", "with", "and", "or", "of",
  "is", "it", "that", "this",
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean),
  );
}

/** The query tokens a title must contain: distinctive, minus filler/color/storage. */
export function significantQueryTokens(query: string): string[] {
  const colors = new Set<string>(COLORS as readonly string[]);
  const out: string[] = [];
  for (const t of (query ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)) {
    if (!t) continue;
    if (t.length < 2 && !/\d/.test(t)) continue; // drop lone letters (keep lone digits)
    if (QUERY_FILLER.has(t)) continue;
    if (colors.has(t)) continue; // color is a variant choice
    if (/^\d+(gb|tb)$/.test(t)) continue; // storage is a variant choice
    out.push(t);
  }
  return out;
}

/**
 * True when `title` contains every significant token in `query`. Subset match on
 * whole tokens (so "15" never matches "150" and "18" never matches "15"); extra
 * tokens in the title are fine, so family variants still qualify. An empty query
 * (nothing distinctive) matches everything, to stay lenient on vague searches.
 */
export function titleMatchesQuery(query: string, title: string): boolean {
  const wanted = significantQueryTokens(query);
  if (!wanted.length) return true;
  const have = tokenSet(title);
  return wanted.every((t) => have.has(t));
}

export function normalizedProductName(title: string): string {
  let s = (title ?? "").toLowerCase();
  s = s.replace(/\b(\d+\s*(?:gb|tb))\b/gi, " ");
  for (const c of COLORS) {
    s = s.replace(new RegExp(`\\b${c}\\b`, "gi"), " ");
  }
  s = s.replace(/\b(xxx?l|xxl|xl|xxs|xs)\b/gi, " ");
  s = s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/** Integer cents, ISO currency, variant tokens, tax-included flag. */
export function normalizeListing(listing: ProductListing): ProductListing {
  const priceCents = Math.round(Number(listing.priceCents));
  const extracted = extractListingVariants(listing.productTitle);
  const currency = (listing.currency || "USD").toUpperCase();
  const includesTax =
    listing.includesTax === true ||
    /\btax\s+included\b/i.test(listing.productTitle ?? "");
  return {
    ...listing,
    priceCents: Number.isFinite(priceCents) && priceCents > 0 ? priceCents : 0,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    color: listing.color ?? extracted.color,
    storage: listing.storage ?? extracted.storage,
    size: listing.size ?? extracted.size,
    normalizedName: listing.normalizedName ?? normalizedProductName(listing.productTitle),
    includesTax,
    variants: listing.variants,
  };
}

function isAccessoryTitle(title: string): boolean {
  return ACCESSORY_TITLE.test(title ?? "");
}

function isConditionTitle(title: string): boolean {
  return CONDITION.test(title ?? "");
}

function inPriceRange(kind: SearchQueryKind, category: PriceCategory, priceCents: number): boolean {
  if (!Number.isFinite(priceCents) || priceCents <= 0) return false;
  if (kind === "accessory") {
    return priceCents >= ACCESSORY_RANGE.min && priceCents <= ACCESSORY_RANGE.max;
  }
  if (kind === "device" && category !== "other") {
    const range = DEVICE_RANGE[category];
    return priceCents >= range.min && priceCents <= range.max;
  }
  return true;
}

function nestVariants(listings: ProductListing[]): ProductListing[] {
  const groups = new Map<string, ProductListing[]>();
  for (const l of listings) {
    const name = l.normalizedName || normalizedProductName(l.productTitle);
    const key = `${name}|${l.storeSlug}`;
    const row = groups.get(key) ?? [];
    row.push(l);
    groups.set(key, row);
  }
  const nested: ProductListing[] = [];
  for (const row of groups.values()) {
    const scored = [...row].sort((a, b) => {
      const ai = /^https?:\/\//i.test(a.imageUrl ?? "") ? 0 : 1;
      const bi = /^https?:\/\//i.test(b.imageUrl ?? "") ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return a.priceCents - b.priceCents;
    });
    const parent = { ...scored[0]!, variants: undefined as ProductListing[] | undefined };
    const rest = scored.slice(1);
    if (rest.length) parent.variants = rest.map((v) => ({ ...v, variants: undefined }));
    nested.push(parent);
  }
  nested.sort((a, b) => a.priceCents - b.priceCents);
  return nested;
}

export function filterCatalogListings(
  listings: ProductListing[],
  query: string,
  kind: SearchQueryKind = classifySearchQuery(query),
): { listings: ProductListing[]; drops: FilterDrop[] } {
  const category = priceCategoryForQuery(query);
  const drops: FilterDrop[] = [];
  const kept: ProductListing[] = [];

  for (const raw of listings) {
    const listing = normalizeListing(raw);
    if (isConditionTitle(listing.productTitle)) {
      drops.push({ listing, reason: "condition" });
      continue;
    }
    if (kind === "device" && isAccessoryTitle(listing.productTitle)) {
      drops.push({ listing, reason: "accessory" });
      continue;
    }
    if (!inPriceRange(kind, category, listing.priceCents)) {
      drops.push({ listing, reason: "price" });
      continue;
    }
    if (!listingMerchantAllowed(listing)) {
      drops.push({ listing, reason: "merchant" });
      continue;
    }
    if (!titleMatchesQuery(query, listing.productTitle)) {
      drops.push({ listing, reason: "relevance" });
      continue;
    }
    kept.push(listing);
  }

  const nested = nestVariants(kept);
  const capped = nested.slice(0, 5);
  for (const listing of nested.slice(5)) {
    drops.push({ listing, reason: "cap" });
  }
  return { listings: capped, drops };
}

/** Flatten parents + nested variants for session cache / pick resolution. */
export function flattenCatalogListings(listings: ProductListing[]): ProductListing[] {
  const out: ProductListing[] = [];
  for (const l of listings) {
    out.push(l);
    for (const v of l.variants ?? []) out.push(v);
  }
  return out;
}

/** Pick a nested variant from persisted listings using CONTINUE text. */
export function resolveListingPick(listing: ProductListing, text: string): ProductListing {
  const variants = listing.variants ?? [];
  if (!variants.length) return listing;
  const tokens = (text ?? "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^(the|one|that|this|from|with|and)\b/.test(w));
  if (!tokens.length) return listing;
  let best: { listing: ProductListing; score: number } | null = null;
  for (const v of [listing, ...variants]) {
    const bag = `${v.productTitle} ${v.color ?? ""} ${v.storage ?? ""} ${v.size ?? ""}`.toLowerCase();
    const score = tokens.filter((t) => bag.includes(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { listing: v, score };
  }
  return best?.listing ?? listing;
}
