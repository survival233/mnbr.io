/**
 * City + airport normalization for the US↔Ghana corridor.
 * Matching uses exact destinationCity strings today; without this, "ACC",
 * "Kotoka", and "Accra" would never match each other.
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
  | "London";

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
};

const GHANA: ReadonlySet<string> = new Set(["Accra", "Kumasi", "Tamale"]);
const US: ReadonlySet<string> = new Set([
  "New York", "Newark", "Washington", "Atlanta", "Chicago", "Houston", "Los Angeles", "Dallas", "Boston",
]);

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

/** Infer TripDirection from origin/destination. Returns null if ambiguous. */
export function inferDirection(
  departureCity: string,
  destinationCity: string,
): "us_to_gh" | "gh_to_us" | null {
  if (isUsCity(departureCity) && isGhanaCity(destinationCity)) return "us_to_gh";
  if (isGhanaCity(departureCity) && isUsCity(destinationCity)) return "gh_to_us";
  // transit via London still lands in the corridor if one end is Ghana
  if (isGhanaCity(destinationCity) && !isGhanaCity(departureCity)) return "us_to_gh";
  if (isGhanaCity(departureCity) && !isGhanaCity(destinationCity)) return "gh_to_us";
  return null;
}
