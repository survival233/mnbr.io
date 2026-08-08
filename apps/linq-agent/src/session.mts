import { endOfLocalDay } from "@manebra/shared";
import type { ProductListing } from "@manebra/catalog";
import { loadSessionsInto, schedulePersist, persistNow } from "./session-store.mts";

export type Step =
  | "idle"
  | "await_product"
  | "await_shopping_city"
  | "await_listing"
  | "await_delivery_city"
  | "await_deadline"
  | "await_max_fee"
  | "await_extend"
  | "await_traveler"
  | "await_pay_confirm"
  | "await_handover_done"
  | "done";

export type RankedTraveler = {
  id: string;
  name: string;
  score: number;
  departs: string;
};

export type Session = {
  phone: string;
  chatId: string | null;
  step: Step;
  searchQuery?: string;
  shoppingCity: string;
  deliveryCity?: string;
  deadline?: Date;
  maxFeeCents?: number;
  category?: string;
  listings?: ProductListing[];
  selected?: ProductListing;
  ranked?: RankedTraveler[];
  extendCandidate?: RankedTraveler;
  chosenTravelerId?: string;
  bidId?: string;
  escrowId?: string;
  handoverCode?: string;
  fundTxHash?: string;
  totalCents?: number;
  updatedAt: number;
};

const byPhone = new Map<string, Session>();
let loaded = false;

/** Call once at process start before accepting webhooks. */
export function initSessionStore(): void {
  if (loaded) return;
  loaded = true;
  loadSessionsInto(byPhone);
}

function touchPersist() {
  schedulePersist(byPhone);
}

export function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function getOrCreateSession(phone: string, chatId: string | null): Session {
  if (!loaded) initSessionStore();
  const key = digits(phone);
  let s = byPhone.get(key);
  if (!s) {
    s = {
      phone,
      chatId,
      step: "idle",
      shoppingCity: "New York",
      updatedAt: Date.now(),
    };
    byPhone.set(key, s);
  }
  if (chatId) s.chatId = chatId;
  s.updatedAt = Date.now();
  touchPersist();
  return s;
}

export function resetSession(s: Session) {
  s.step = "idle";
  s.searchQuery = undefined;
  s.shoppingCity = "New York";
  s.deliveryCity = undefined;
  s.deadline = undefined;
  s.maxFeeCents = undefined;
  s.category = undefined;
  s.listings = undefined;
  s.selected = undefined;
  s.ranked = undefined;
  s.extendCandidate = undefined;
  s.chosenTravelerId = undefined;
  s.bidId = undefined;
  s.escrowId = undefined;
  s.handoverCode = undefined;
  s.fundTxHash = undefined;
  s.totalCents = undefined;
  s.updatedAt = Date.now();
  touchPersist();
}

export function markSessionDirty() {
  touchPersist();
}

export function persistSessionsNow() {
  persistNow(byPhone);
}

export function sessionStats(): { count: number; lastActivityAt: number | null } {
  let last: number | null = null;
  for (const s of byPhone.values()) {
    if (last == null || s.updatedAt > last) last = s.updatedAt;
  }
  return { count: byPhone.size, lastActivityAt: last };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Accepts "15th August", "aug 15", "15/08", "2026-08-15". */
export function parseDate(text: string): Date | null {
  const t = text.toLowerCase().trim();
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
  } else return null;
  const now = new Date();
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
