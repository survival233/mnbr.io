/**
 * City + airport normalization. Known IATA/aliases collapse to one name;
 * any other proper name is kept as-is so origin→destination is not a corridor.
 */

export type CorridorCity =
  | "Accra"
  | "Kumasi"
  | "Tamale"
  | "New York"
  | "Newark"
  | "Washington"
  | "Atlanta"
  | "Chicago"
  | "Houston"
  | "Los Angeles"
  | "Dallas"
  | "Boston"
  | "London"
  | "San José"
  | "Buenos Aires";

const ALIASES: Record<string, CorridorCity> = {
  // Ghana
  accra: "Accra",
  acc: "Accra",
  kotoka: "Accra",
  "kotoka international": "Accra",
  "kotoka international airport": "Accra",
  // Greater Accra handoff cities — travelers land ACC, deliver locally
  tema: "Accra",
  madina: "Accra",
  kasoa: "Accra",
  legon: "Accra",
  "east legon": "Accra",
  spintex: "Accra",
  "airport residential": "Accra",
  kumasi: "Kumasi",
  kms: "Kumasi",
  tamale: "Tamale",
  tml: "Tamale",
  // US hubs common on the corridor
  "new york": "New York",
  nyc: "New York",
  jfk: "New York",
  lga: "New York",
  "john f kennedy": "New York",
  "john f. kennedy": "New York",
  newark: "Newark",
  ewr: "Newark",
  washington: "Washington",
  "washington dc": "Washington",
  "washington d.c.": "Washington",
  iad: "Washington",
  dca: "Washington",
  dulles: "Washington",
  atlanta: "Atlanta",
  atl: "Atlanta",
  chicago: "Chicago",
  ord: "Chicago",
  "o'hare": "Chicago",
  houston: "Houston",
  iah: "Houston",
  "los angeles": "Los Angeles",
  lax: "Los Angeles",
  la: "Los Angeles",
  dallas: "Dallas",
  dfw: "Dallas",
  boston: "Boston",
  bos: "Boston",
  // transit hubs that show up on multi-leg
  london: "London",
  lhr: "London",
  heathrow: "London",
  sjo: "San José",
  "san jose": "San José",
  "san josé": "San José",
  eze: "Buenos Aires",
  aep: "Buenos Aires",
  "buenos aires": "Buenos Aires",
};

const GHANA: ReadonlySet<string> = new Set(["Accra", "Kumasi", "Tamale"]);
const US: ReadonlySet<string> = new Set([
  "New York", "Newark", "Washington", "Atlanta", "Chicago", "Houston", "Los Angeles", "Dallas", "Boston",
]);

/** Same destination only — Accra≠Kumasi. Aliases (ACC, Kotoka) still count as Accra. */
export function sameDestinationCity(a?: string | null, b?: string | null): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const na = normalizeCity(a) ?? a.trim();
  const nb = normalizeCity(b) ?? b.trim();
  return na.toLowerCase() === nb.toLowerCase();
}

/** Normalize a free-text city / airport into a canonical corridor city, or null. */
export function normalizeCity(raw: string | null | undefined): CorridorCity | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (ALIASES[t]) return ALIASES[t];
  // substring scan for "Flight to Accra (ACC)" style titles
  for (const [alias, city] of Object.entries(ALIASES)) {
    if (alias.length >= 3 && (t.includes(alias) || t.split(/[\s\-–—/|]+/).includes(alias))) {
      return city;
    }
  }
  // title-case unknown city if it looks like a proper name
  if (/^[a-z][a-z\s'-]{1,40}$/.test(t)) {
    return t.replace(/\b\w/g, (c) => c.toUpperCase()) as CorridorCity;
  }
  return null;
}

export function isGhanaCity(city: string): boolean {
  return GHANA.has(city);
}

export function isUsCity(city: string): boolean {
  return US.has(city);
}

/**
 * Lane for Prisma TripDirection (enum is still us_to_gh | gh_to_us).
 * Any distinct origin→destination is a trip. Inbound to a US hub is gh_to_us;
 * every other pair is us_to_gh. Not a Ghana check.
 */
export function inferDirection(
  departureCity: string,
  destinationCity: string,
): "us_to_gh" | "gh_to_us" | null {
  const from = (normalizeCity(departureCity) ?? departureCity).trim();
  const to = (normalizeCity(destinationCity) ?? destinationCity).trim();
  if (!from || !to) return null;
  if (from.toLowerCase() === to.toLowerCase()) return null;
  if (isUsCity(to) && !isUsCity(from)) return "gh_to_us";
  return "us_to_gh";
}
