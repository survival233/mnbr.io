import { AIRPORTS, ALIASES, CATCHMENTS, type AirportRow } from "./airports";

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

function lookupKnown(t: string): Metro | null {
  if (/^[a-z]{3}$/.test(t) && BY_IATA.has(t)) return metroOf(BY_IATA.get(t)!);

  const named = ALIASES[t] ?? CATCHMENTS[t];
  if (named && BY_METRO.has(named)) return metroOf(BY_METRO.get(named)!);

  if (BY_CITY.has(t)) return metroOf(BY_CITY.get(t)!);
  if (BY_METRO.has(slug(t))) return metroOf(BY_METRO.get(slug(t))!);

  for (const tok of t.split(/[\s\-–—/|]+/)) {
    if (tok.length === 3 && BY_IATA.has(tok)) return metroOf(BY_IATA.get(tok)!);
    const tokNamed = ALIASES[tok] ?? CATCHMENTS[tok];
    if (tokNamed && BY_METRO.has(tokNamed)) return metroOf(BY_METRO.get(tokNamed)!);
    if (BY_CITY.has(tok)) return metroOf(BY_CITY.get(tok)!);
  }
  return null;
}

/**
 * IATA, hub city, airport alias, or catchment town → metro.
 * Unknown proper names are not hubs (use resolveMetro for those).
 */
export function resolveHub(raw?: string | null): Metro | null {
  if (!raw?.trim()) return null;
  const t = clean(raw);
  if (!t) return null;
  return lookupKnown(t);
}

/** Canonical hub city for matching stamps (Tema → Accra, ACC → Accra). */
export function hubCity(raw?: string | null): string | null {
  return resolveHub(raw)?.city ?? null;
}

/** Guest-facing town: catchment names stay (Tema), hubs use the airport city (Accra). */
export function guestTown(raw?: string | null): string | null {
  if (!raw?.trim()) return null;
  const t = clean(raw);
  if (!t) return null;
  if (CATCHMENTS[t]) return titleCity(raw);
  const known = lookupKnown(t);
  if (known) return known.city;
  if (/^[a-z][a-z\s'-]{1,40}$/.test(t)) return titleCity(raw);
  return null;
}

/**
 * Resolve free text or a stored trip city to a metro.
 * Known hubs and catchment towns share a metro. Unknown proper names get their own.
 * A different hub city is never collapsed (Accra ≠ Kumasi).
 */
export function resolveMetro(raw?: string | null): Metro | null {
  if (!raw?.trim()) return null;
  const t = clean(raw);
  if (!t) return null;

  const known = lookupKnown(t);
  if (known) return known;

  if (/^[a-z][a-z\s'-]{1,40}$/.test(t)) {
    const id = slug(t);
    if (!id) return null;
    return { id, city: titleCity(t), country: "" };
  }
  return null;
}

/** Same hub or catchment. Accra = Tema. Accra ≠ Kumasi. JFK = New York. */
export function sameMetro(a?: string | null, b?: string | null): boolean {
  const ma = resolveMetro(a);
  const mb = resolveMetro(b);
  if (!ma || !mb) return false;
  return ma.id === mb.id;
}
