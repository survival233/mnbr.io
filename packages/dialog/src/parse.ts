import { endOfLocalDay } from "@manebra/shared";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Accepts "15th August", "aug 15", "15/08", "2026-08-15", "today", "tomorrow", "the 20th". */
export function parseDate(text: string): Date | null {
  const t = text.toLowerCase().trim().replace(/^[,\s]+/, "");
  const now = new Date();
  if (/^today\b/.test(t)) return endOfLocalDay(now);
  if (/^tomorrow\b/.test(t)) return endOfLocalDay(new Date(now.getTime() + 86400_000));
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return endOfLocalDay(new Date(+iso[1], +iso[2] - 1, +iso[3]));
  const slash = t.match(/^(\d{1,2})[\/.](\d{1,2})$/);
  const m =
    t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/) ||
    t.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?/);
  let day: number, mon: number;
  if (slash) {
    day = +slash[1];
    mon = +slash[2] - 1;
  } else if (m) {
    day = parseInt(m[1].match(/\d/) ? m[1] : m[2], 10);
    mon = MONTHS[(m[1].match(/\d/) ? m[2] : m[1]).slice(0, 3)]!;
  } else {
    const dayOnly = t.match(/^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?$/);
    if (!dayOnly) return null;
    day = +dayOnly[1]!;
    mon = now.getMonth();
  }
  let d = endOfLocalDay(new Date(now.getFullYear(), mon, day));
  if (d < now) d = endOfLocalDay(new Date(now.getFullYear() + 1, mon, day));
  return d;
}

export function parseUsdCents(text: string): number | null {
  const n = Math.round(parseFloat(text.replace(/[$,\s]/g, "")) * 100);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function categoryOf(itemName: string): string | null {
  const t = itemName.toLowerCase();
  if (/iphone|ipad|laptop|macbook|phone|electronic|console|playstation|xbox|camera|drone|watch|airpod|headphone/.test(t))
    return "electronics";
  if (/shoe|sneaker|cloth|dress|shirt|jean|jacket|bag/.test(t)) return "clothing_shoes";
  if (/perfume|cream|lotion|makeup|cosmetic|skincare/.test(t)) return "cosmetics_sealed";
  if (/book|novel|vinyl|dvd/.test(t)) return "books_media";
  if (/chocolate|snack|coffee|tea|spice|cereal/.test(t)) return "food_sealed_nonperishable";
  return null;
}
