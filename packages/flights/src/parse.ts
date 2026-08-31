import { hubCity, hubIata, destinationMetro } from "@manebra/geo";
import type { FlightSearchQuery } from "./types.js";

export function toAirportCode(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const iata = hubIata(t) ?? hubIata(destinationMetro(t)?.city ?? "");
  if (iata) return iata;
  if (/^[a-z]{3}$/i.test(t)) return t.toUpperCase();
  return null;
}

/** Resolve a free-text place reply into an airport code (for slot fills). */
export function resolvePlace(raw: string): string | null {
  return toAirportCode(raw);
}

export function formatFlightOption(
  o: {
    airline: string;
    flightNumber?: string;
    origin: string;
    destination: string;
    departAt: Date;
    arriveAt: Date;
    stops: number;
    priceCents: number;
  },
  index: number,
): string {
  const dep = fmtTime(o.departAt);
  const arr = fmtTime(o.arriveAt);
  const stops = o.stops === 0 ? "nonstop" : `${o.stops} stop${o.stops > 1 ? "s" : ""}`;
  const price = `$${(o.priceCents / 100).toFixed(0)}`;
  const fn = o.flightNumber ? ` ${o.flightNumber}` : "";
  return (
    `${index + 1}. ${o.airline}${fn} · ${o.origin}→${o.destination}\n` +
    `   ${dep} → ${arr} · ${stops} · ${price}`
  );
}

function fmtTime(d: Date): string {
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Parse "15th August", "August 15", "aug 15 2026", ISO, slash dates. */
export function parseDepartDate(text: string): string | null {
  const t = text.trim();
  const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;

  const slash = t.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/);
  if (slash) {
    const now = new Date();
    const mon = Number(slash[1]) - 1;
    const day = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    let d = new Date(year, mon, day);
    if (d < now) d = new Date(year + 1, mon, day);
    return isoDate(d);
  }

  const dayMonth =
    t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?\b/i) ||
    t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/i);
  if (dayMonth) {
    const now = new Date();
    let day: number;
    let monName: string;
    let yearStr: string | undefined;
    if (/^\d/.test(dayMonth[1]!)) {
      day = Number(dayMonth[1]);
      monName = dayMonth[2]!.toLowerCase();
      yearStr = dayMonth[3];
    } else {
      monName = dayMonth[1]!.toLowerCase();
      day = Number(dayMonth[2]);
      yearStr = dayMonth[3];
    }
    const mon = MONTHS[monName.slice(0, 3)] ?? MONTHS[monName];
    if (mon == null || !Number.isFinite(day)) return null;
    let year = yearStr ? Number(yearStr) : now.getFullYear();
    let d = new Date(year, mon, day);
    if (!yearStr && d < now) d = new Date(year + 1, mon, day);
    return isoDate(d);
  }

  return null;
}

export function parseTravelIntent(text: string): Partial<FlightSearchQuery> & { note?: string } {
  const t = text.trim();
  const out: Partial<FlightSearchQuery> & { note?: string } = {};

  // "from A to B …"
  const fromTo = t.match(
    /\bfrom\s+([a-zA-Z\s.]+?)\s+to\s+([a-zA-Z\s.]+?)(?:\s|$|,|\.|on|by|friday|monday|tuesday|wednesday|thursday|saturday|sunday)/i,
  );
  if (fromTo) {
    out.origin = toAirportCode(fromTo[1]!) ?? fromTo[1]!.trim();
    out.destination = toAirportCode(fromTo[2]!) ?? fromTo[2]!.trim();
  }

  // "New York to Accra" / "JFK → ACC" — only if both sides resolve to airports
  // (avoids eating "need to be in …")
  if (!out.origin || !out.destination) {
    const route = t.match(
      /\b([A-Za-z][A-Za-z\s.]{0,40}?)\s*(?:→|->|—|–|to)\s*([A-Za-z][A-Za-z\s.]{0,40}?)(?:\s|$|,|\.|on|by|friday|monday|tuesday|wednesday|thursday|saturday|sunday)/i,
    );
    if (route) {
      const o = toAirportCode(route[1]!);
      const d = toAirportCode(route[2]!);
      if (o && d) {
        out.origin = o;
        out.destination = d;
      }
    }
  }

  if (!out.destination) {
    const placeTail =
      "(?:\\s+(?:on|by|friday|monday|tuesday|wednesday|thursday|saturday|sunday|this|next|morning|evening)|$|,|\\.)";
    const toM =
      t.match(new RegExp(`\\bbe in\\s+([A-Za-z][A-Za-z\\s.'-]{1,40}?)${placeTail}`, "i")) ||
      t.match(
        new RegExp(
          `\\b(?:going|flying|heading|headed|traveling|travelling|off|trip|flight|fly)\\s+to\\s+([A-Za-z][A-Za-z\\s.'-]{1,40}?)${placeTail}`,
          "i",
        ),
      ) ||
      t.match(new RegExp(`\\b(?:to|into)\\s+([A-Za-z][A-Za-z\\s.'-]{1,40}?)${placeTail}`, "i"));
    if (toM) out.destination = toAirportCode(toM[1]!) ?? toM[1]!.trim();
  }
  if (!out.origin) {
    const fromM = t.match(/\bfrom\s+([A-Za-z][A-Za-z\s.]{1,30}?)(?:\s|$|,|\.|to)/i);
    if (fromM) out.origin = toAirportCode(fromM[1]!) ?? fromM[1]!.trim();
  }

  const friday = /\b(next\s+)?friday\b/i.test(t);
  const morning = /\bmorning\b/i.test(t);
  const evening = /\bevening\b/i.test(t);
  if (friday) {
    const d = nextWeekday(5);
    out.departDate = isoDate(d);
    if (morning) {
      const arriveBy = new Date(d);
      arriveBy.setHours(12, 0, 0, 0);
      out.arriveBy = arriveBy;
      const dep = new Date(d);
      dep.setDate(dep.getDate() - 1);
      out.departDate = isoDate(dep);
      out.note = "Aiming to arrive Friday morning";
    } else if (evening) {
      const arriveBy = new Date(d);
      arriveBy.setHours(23, 59, 0, 0);
      out.arriveBy = arriveBy;
    }
  }

  const named = parseDepartDate(t);
  if (named) out.departDate = named;

  return out;
}

function nextWeekday(target: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const delta = (target - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d;
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isTravelIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\b(flight|flights|fly|flying|airfare|airline|book\s+me\s+a\s+flight)\b/i.test(t)) return true;
  if (/\b(i need to be in|get me to|traveling to|travel to|trip to)\b/i.test(t)) return true;
  if (/\b[A-Za-z]{3,}\s*(?:→|->|to)\s*[A-Za-z]{3,}\b/i.test(t)) return true;
  if (
    /\b(depart|departure|arrive|arrival)\b/i.test(t) &&
    /\b(jfk|acc|accra|new york|atlanta)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

export function cityFromAirport(code: string): string {
  return hubCity(code) ?? code;
}
