import { AIRPORTS, ALIASES, type AirportRow } from "./airports";

export type Metro = {
  id: string;
  city: string;
  country: string;
};

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function clean(raw: string): string {
  return raw.toLowerCase().replace(/[(),.]/g, " ").replace(/\s+/g, " ").trim();
}

function titleCity(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const BY_IATA = new Map<string, AirportRow>();
const BY_METRO = new Map<string, AirportRow>();
const BY_CITY = new Map<string, AirportRow>();

for (const row of AIRPORTS) {
  BY_IATA.set(row.iata.toLowerCase(), row);
  if (!BY_METRO.has(row.metro)) BY_METRO.set(row.metro, row);
  BY_CITY.set(clean(row.city), row);
}

function metroOf(row: AirportRow): Metro {
  return { id: row.metro, city: row.city, country: row.country };
}

/**
 * Resolve free text or a stored trip city to a metro.
 * IATA, city, and airport aliases share a metro. Unknown proper names get their own metro.
 * Nearby cities are not collapsed.
 */
export function resolveMetro(raw?: string | null): Metro | null {
  if (!raw?.trim()) return null;
  const t = clean(raw);
  if (!t) return null;

  if (/^[a-z]{3}$/.test(t) && BY_IATA.has(t)) return metroOf(BY_IATA.get(t)!);

  const alias = ALIASES[t];
  if (alias && BY_METRO.has(alias)) return metroOf(BY_METRO.get(alias)!);

  if (BY_CITY.has(t)) return metroOf(BY_CITY.get(t)!);
  if (BY_METRO.has(slug(t))) return metroOf(BY_METRO.get(slug(t))!);

  for (const tok of t.split(/[\s\-–—/|]+/)) {
    if (tok.length === 3 && BY_IATA.has(tok)) return metroOf(BY_IATA.get(tok)!);
    if (ALIASES[tok] && BY_METRO.has(ALIASES[tok]!)) return metroOf(BY_METRO.get(ALIASES[tok]!)!);
    if (BY_CITY.has(tok)) return metroOf(BY_CITY.get(tok)!);
  }

  if (/^[a-z][a-z\s'-]{1,40}$/.test(t)) {
    const id = slug(t);
    if (!id) return null;
    return { id, city: titleCity(t), country: "" };
  }
  return null;
}

/** Arrival match: same metro only. Accra ≠ Kumasi. JFK = New York. */
export function sameMetro(a?: string | null, b?: string | null): boolean {
  const ma = resolveMetro(a);
  const mb = resolveMetro(b);
  if (!ma || !mb) return false;
  return ma.id === mb.id;
}
