/** Strict US shopping-city helpers — never treat free chat as a city. */

export const US_SHOP_HUBS = [
  "New York",
  "Newark",
  "Washington",
  "Atlanta",
  "Chicago",
  "Houston",
  "Los Angeles",
  "Dallas",
  "Boston",
] as const;

export type UsShopHub = (typeof US_SHOP_HUBS)[number];

const ALIAS: Record<string, UsShopHub> = {
  "new york": "New York",
  nyc: "New York",
  ny: "New York",
  jfk: "New York",
  lga: "New York",
  manhattan: "New York",
  brooklyn: "New York",
  newark: "Newark",
  ewr: "Newark",
  washington: "Washington",
  "washington dc": "Washington",
  "washington d.c.": "Washington",
  dc: "Washington",
  dulles: "Washington",
  iad: "Washington",
  atlanta: "Atlanta",
  atl: "Atlanta",
  chicago: "Chicago",
  ord: "Chicago",
  houston: "Houston",
  iah: "Houston",
  "los angeles": "Los Angeles",
  la: "Los Angeles",
  lax: "Los Angeles",
  dallas: "Dallas",
  dfw: "Dallas",
  boston: "Boston",
  bos: "Boston",
};

/** True if the user is asking for a recommendation, not naming a city. */
export function isCityAdviceQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/^(which|what|where|recommend|best|suggest)/i.test(t)) return true;
  if (/\b(best|better|recommend|suggestion|should i|which one)\b/i.test(t)) return true;
  if (/\b(which|what)\s+(city|cities|hub|place)\b/i.test(t)) return true;
  return false;
}

/** Parse a concrete US shopping hub, or null if not a known city. */
export function parseUsShoppingCity(text: string): UsShopHub | null {
  const t = text
    .toLowerCase()
    .replace(/[?!.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 40) return null;
  if (isCityAdviceQuestion(text)) return null;
  if (ALIAS[t]) return ALIAS[t];
  for (const [alias, city] of Object.entries(ALIAS)) {
    if (alias.length < 2) continue;
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t)) {
      if (t.split(/\s+/).length <= 5) return city;
    }
  }
  return null;
}
