import { normalizeCity } from "@manebra/calendar";
import type { FlightSearchQuery } from "./types.js";

export function toAirportCode(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (/^[a-z]{3}$/i.test(t)) return t.toUpperCase();
  const city = normalizeCity(raw);
  const map: Record<string, string> = {
    "New York": "JFK",
    Newark: "EWR",
    Washington: "IAD",
    Atlanta: "ATL",
    Chicago: "ORD",
    Houston: "IAH",
    "Los Angeles": "LAX",
    Dallas: "DFW",
    Boston: "BOS",
    Accra: "ACC",
    Kumasi: "KMS",
    Tamale: "TML",
    London: "LHR",
  };
  if (city && map[city]) return map[city]!;
  const aliases: Record<string, string> = {
    nyc: "JFK",
    "new york city": "JFK",
    manhattan: "JFK",
    ghana: "ACC",
    accra: "ACC",
  };
  return aliases[t] ?? null;
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

export function parseTravelIntent(text: string): Partial<FlightSearchQuery> & { note?: string } {
  const t = text.trim();
  const out: Partial<FlightSearchQuery> & { note?: string } = {};

  const fromTo = t.match(
    /\bfrom\s+([a-zA-Z\s.]+?)\s+to\s+([a-zA-Z\s.]+?)(?:\s|$|,|\.|on|by|friday|monday|tuesday|wednesday|thursday|saturday|sunday)/i,
  );
  if (fromTo) {
    out.origin = toAirportCode(fromTo[1]!) ?? fromTo[1]!.trim();
    out.destination = toAirportCode(fromTo[2]!) ?? fromTo[2]!.trim();
  } else {
    const toM =
      t.match(
        /\b(?:to|in|into)\s+([A-Za-z][A-Za-z\s.]{1,30}?)(?:\s+(?:on|by|friday|monday|tuesday|wednesday|thursday|saturday|sunday|this|next|,|\.|$))/i,
      ) || t.match(/\bbe in\s+([A-Za-z][A-Za-z\s.]{1,30}?)(?:\s|$)/i);
    if (toM) out.destination = toAirportCode(toM[1]!) ?? toM[1]!.trim();
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

  const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) out.departDate = iso[1];

  const slash = t.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/);
  if (slash && !out.departDate) {
    const now = new Date();
    const mon = Number(slash[1]) - 1;
    const day = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    let d = new Date(year, mon, day);
    if (d < now) d = new Date(year + 1, mon, day);
    out.departDate = isoDate(d);
  }

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
  if (
    /\b(depart|departure|arrive|arrival)\b/i.test(t) &&
    /\b(jfk|acc|accra|new york|atlanta)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

export function cityFromAirport(code: string): string {
  const m: Record<string, string> = {
    JFK: "New York",
    LGA: "New York",
    EWR: "Newark",
    IAD: "Washington",
    DCA: "Washington",
    ATL: "Atlanta",
    ORD: "Chicago",
    IAH: "Houston",
    LAX: "Los Angeles",
    DFW: "Dallas",
    BOS: "Boston",
    ACC: "Accra",
    KMS: "Kumasi",
    TML: "Tamale",
    LHR: "London",
  };
  return m[code.toUpperCase()] ?? code;
}
