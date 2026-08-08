/**
 * Verified retailers we will surface. Live results from other sites are dropped.
 * We do not integrate Apple/Best Buy/Walmart APIs — only public shopping search.
 */
export const VERIFIED_STORES = [
  { slug: "apple", name: "Apple Store", domains: ["apple.com"], aliases: ["apple", "apple store"] },
  { slug: "bestbuy", name: "Best Buy", domains: ["bestbuy.com"], aliases: ["best buy", "bestbuy"] },
  { slug: "walmart", name: "Walmart", domains: ["walmart.com"], aliases: ["walmart"] },
  { slug: "target", name: "Target", domains: ["target.com"], aliases: ["target"] },
  { slug: "amazon", name: "Amazon", domains: ["amazon.com", "amazon.com/"], aliases: ["amazon", "amazon.com"] },
] as const;

export type StoreSlug = (typeof VERIFIED_STORES)[number]["slug"];

export function matchVerifiedStore(source: string, link?: string): {
  slug: StoreSlug;
  name: string;
} | null {
  const s = source.toLowerCase().trim();
  const href = (link ?? "").toLowerCase();
  for (const store of VERIFIED_STORES) {
    if (store.aliases.some((a) => s === a || s.includes(a))) {
      return { slug: store.slug, name: store.name };
    }
    if (store.domains.some((d) => href.includes(d))) {
      return { slug: store.slug, name: store.name };
    }
  }
  return null;
}

export const SHOPPING_CITIES = [
  "New York", "Newark", "Atlanta", "Houston", "Chicago", "Los Angeles", "Dallas", "Boston", "Washington",
] as const;

export function supportedShoppingCities(): string[] {
  return [...SHOPPING_CITIES];
}
