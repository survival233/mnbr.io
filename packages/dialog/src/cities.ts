/** Buy-from / traveler-home town helpers. Never treat an advice question as a city. */

import { destinationMetro, guestTown, hubCity, originMetro, placeMetro, resolveHub } from "@manebra/geo";

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

/** Traveler-home / buy-from town. Known hub or catchment, not free chat. */
export function parseShoppingCity(text: string): string | null {
  if (isCityAdviceQuestion(text)) return null;
  const us = parseUsShoppingCity(text);
  if (us) return us;
  return hubCity(text);
}

/** Shopper's town as they named it (Tema stays Tema; ACC → Accra). Any geo metro. */
export function parseDeliveryTown(text: string): string | null {
  if (isCityAdviceQuestion(text)) return null;
  const t = text.trim();
  if (!t || t.length > 60) return null;
  const m = destinationMetro(t) ?? placeMetro(t) ?? resolveHub(t);
  if (!m) return null;
  return guestTown(t) ?? m.city;
}

/** Guest city name for a trip destination. Never an IATA code. */
export function parseTripDestination(text: string): string | null {
  if (isCityAdviceQuestion(text)) return null;
  return destinationMetro(text)?.city ?? null;
}

/** Guest city name for a trip origin. Never an IATA code. */
export function parseTripOrigin(text: string): string | null {
  if (isCityAdviceQuestion(text)) return null;
  return originMetro(text)?.city ?? null;
}

/** True when the utterance names where they are going, not a bare origin fill. */
export function isDestinationShaped(text: string): boolean {
  return (
    /\b(?:going|flying|heading|headed|traveling|travelling|off|trip|flight|fly)\s+to\b/i.test(text) ||
    /\bbe\s+(?:in|at)\b/i.test(text)
  );
}

/** Human city for guest copy. IATA (ACC, LOS) becomes Accra / Lagos. */
export function guestCityName(raw?: string | null): string | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  if (/^[A-Za-z]{3}$/.test(t)) return guestTown(t) ?? hubCity(t) ?? null;
  return guestTown(t) ?? destinationMetro(t)?.city ?? hubCity(t) ?? t;
}
