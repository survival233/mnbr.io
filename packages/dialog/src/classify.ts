/**
 * One inbound turn protocol. Classify against persisted session state,
 * not a list of famous phrases. Search is allowed only after NEW.
 */
import { normalizeCity } from "@manebra/calendar";
import { parseDate, parseUsdCents, categoryOf } from "./parse";
import { parseItem, parseCartQty, extractProductUrl, parseMerchantNames, type MerchantSlug } from "./item";
import { fuzzyMatchIndex } from "./fuzzy";
import { parseShoppingCity, parseDeliveryTown, parseTripDestination, parseTripOrigin } from "./cities";
import { asksForFreshWallet } from "./guest-copy";
import type { ClassifiedTurn, DialogPendingSlot, DialogSession, TurnAct } from "./types";

export type { ClassifiedTurn, DialogPendingSlot, DialogSession, TurnAct } from "./types";

const FORM_STEPS = new Set([
  "await_product",
  "await_product_confirm",
  "await_shopping_city",
  "await_listing",
  "await_delivery_city",
  "await_deadline",
  "await_max_fee",
  "await_extend",
  "await_traveler",
  "await_brief_confirm",
  "await_traveler_decision",
  "await_pay_confirm",
  "await_handover_done",
  "await_travel_intent",
  "await_shop_opt_in",
  "await_traveler_card",
  "await_flight_pick",
  "await_book_confirm",
  "trip_confirmed",
  "await_earn_opt_in",
  "await_job_pick",
]);

const DATE_LEX = [
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

function closestLex(word: string, lexicon: string[], max = 2): string | null {
  const w = word.toLowerCase();
  let best: { t: string; d: number } | null = null;
  for (const t of lexicon) {
    if (Math.abs(t.length - w.length) > 2) continue;
    if (t[0] !== w[0]) continue;
    const d = editDistance(w, t);
    if (d <= max && t.length >= 4 && (!best || d < best.d)) best = { t, d };
  }
  return best?.t ?? null;
}

function softenDateText(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const clean = tok.toLowerCase().replace(/[^a-z]/g, "");
      if (clean.length < 4) return tok;
      return closestLex(clean, DATE_LEX) ?? tok;
    })
    .join(" ");
}

function nextWeekday(name: string): Date {
  const order = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const want = order.indexOf(name.toLowerCase());
  const now = new Date();
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  const delta = (want - now.getDay() + 7) % 7 || 7;
  d.setDate(now.getDate() + delta);
  return d;
}

/** Fuzzy date against expected date type (typos, weekdays, relative). */
export function parseFuzzyDate(text: string): Date | null {
  const t = softenDateText(text);
  const direct = parseDate(t) ?? parseDate(text.trim());
  if (direct) return direct;
  const week = t.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  );
  if (week) return nextWeekday(week[1]!);
  return null;
}

export function filledSlotKeys(s: DialogSession): string[] {
  const keys: string[] = [];
  if (s.searchQuery) keys.push("product");
  if (s.selected) keys.push("listing");
  if (s.deliveryCity) keys.push("delivery_city");
  if (s.deadline) keys.push("need_by");
  if (s.maxFeeCents != null) keys.push("delivery_fee");
  if (s.chosenTravelerId || (s.ranked?.length ?? 0) > 0) keys.push("traveler");
  if (s.shoppingCity && s.searchQuery) keys.push("shopping_city");
  return keys;
}

export function isFormOpen(s: DialogSession): boolean {
  const stay = s.stay;
  return Boolean(
    s.pending?.slot ||
      s.offer ||
      FORM_STEPS.has(s.step) ||
      filledSlotKeys(s).length ||
      stay?.lastItem ||
      stay?.lastOfferId ||
      stay?.lastQuestion,
  );
}

export function requestedSlot(s: DialogSession): DialogPendingSlot | null {
  return s.pending?.slot ? s.pending : null;
}

function lastOptions(s: DialogSession): Array<{ id: string; label: string; haystack?: string }> {
  if (s.pending?.options?.length) {
    return s.pending.options.map((o) => ({ id: o.id, label: o.label, haystack: o.label }));
  }
  if (s.pending?.slot === "listing" || s.step === "await_listing") {
    return (s.listings ?? []).map((l, i) => ({
      id: String(i + 1),
      label: `${l.productTitle} · ${l.storeName}`,
      haystack: `${l.productTitle} ${l.storeName} ${l.priceCents} ${(l.variants ?? [])
        .map((v) => `${v.productTitle} ${v.color ?? ""} ${v.storage ?? ""} ${v.size ?? ""}`)
        .join(" ")}`,
    }));
  }
  if (s.pending?.slot === "traveler" || s.step === "await_traveler") {
    return (s.ranked ?? []).map((r, i) => ({
      id: String(i),
      label: r.name,
      haystack: `${r.name} ${r.departs ?? ""}`,
    }));
  }
  return [];
}

function isDependent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(y|yes|ok|okay|sure|yeah|yep|yup|fine|that one|the first|first one|that works|sounds good|idk|whatever|you pick)\b/i.test(t))
    return true;
  if (/^(n|no|nope|nah)\b/i.test(t)) return true;
  if (/^\d{1,2}(?:st|nd|rd|th)?\.?$/.test(t)) return true;
  if (/^(that|this|hmm|hm|huh|uh|um|idk)\.?$/i.test(t)) return true;
  if (/^\$?\d+(?:\.\d{1,2})?$/.test(t)) return true;
  return false;
}

function isMetaText(text: string): ClassifiedTurn["meta"] | null {
  const t = text.trim();
  if (/^(cancel|never\s?mind|stop|start over|reset)\b/i.test(t)) return "cancel";
  if (/^(status|what'?s happening|what'?s the status|any update|update)\b/i.test(t)) return "status";
  if (/^(wait|waiting|still waiting)\b/i.test(t)) return "wait";
  return null;
}

function isRecapLeftover(s: DialogSession, text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 4) return false;
  const title = s.selected?.productTitle?.toLowerCase() ?? "";
  const q = s.searchQuery?.toLowerCase() ?? "";
  if (title && (title.includes(t) || t.includes(title.slice(0, 24)))) return true;
  if (q && (q === t || title.includes(q) && t === q)) return true;
  return false;
}

function replacementItem(text: string): boolean {
  return /\b(instead|different item|change (the )?item|get me|shop for|look for|search for)\b/i.test(text);
}

export type PendingParse =
  | { ok: true; value?: string | number; optionIndex?: number; applyProposed?: boolean }
  | { ok: false };

function listingReplyText(text: string): string {
  return text
    .replace(/\b(instead|please|lets?|let'?s|go|with|from)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function listingMatchesMerchant(
  listing: NonNullable<DialogSession["listings"]>[number],
  merchant: MerchantSlug,
): boolean {
  const slug = listing.storeSlug?.toLowerCase();
  if (slug === merchant) return true;
  const name = (listing.storeName ?? "").toLowerCase();
  if (merchant === "bestbuy") return /best\s*buy/.test(name);
  if (merchant === "apple") return /\bapple\b/.test(name);
  return name.includes(merchant);
}

function merchantHitsOnList(s: DialogSession, merchant: MerchantSlug): number[] {
  return (s.listings ?? []).flatMap((l, i) => (listingMatchesMerchant(l, merchant) ? [i] : []));
}

/** Store named in the utterance that is actually on the open picker. */
function merchantOnOpenList(s: DialogSession, text: string): MerchantSlug | null {
  if (!s.listings?.length) return null;
  const named = parseMerchantNames(text);
  for (let i = named.length - 1; i >= 0; i--) {
    const m = named[i]!;
    if (merchantHitsOnList(s, m).length) return m;
  }
  return null;
}

/** Pick / qty against persisted SKU cards. Bare yes is never a pick. */
export function parseListingReply(s: DialogSession, text: string): PendingParse {
  const t = listingReplyText(text);
  if (!t || !s.listings?.length) return { ok: false };
  if (/^(y|yes|ok|okay|sure|yeah|yep|yup|fine|that works|sounds good)\b/i.test(t)) {
    return { ok: false };
  }
  const qty = parseCartQty(text);
  if (qty != null) return { ok: true, value: qty };
  if (/^(that one|the first|first one)\b/i.test(t)) {
    return { ok: true, optionIndex: 0 };
  }
  const merchant = merchantOnOpenList(s, text);
  if (merchant) {
    const hits = merchantHitsOnList(s, merchant);
    if (hits.length === 1) return { ok: true, optionIndex: hits[0] };
    if (hits.length > 1) return { ok: true, value: `merchant:${merchant}` };
  }
  const priceAsk = t.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (priceAsk) {
    const cents = Math.round(Number(priceAsk[1]) * 100);
    if (Number.isFinite(cents) && cents > 0) {
      const hit = s.listings.findIndex((l) => l.priceCents === cents);
      if (hit >= 0) return { ok: true, optionIndex: hit };
    }
  }
  if (/\b(cheap|cheaper|cheapest|lowest|less expensive)\b/i.test(t)) {
    let best = 0;
    for (let i = 1; i < s.listings.length; i++) {
      if (s.listings[i]!.priceCents < s.listings[best]!.priceCents) best = i;
    }
    return { ok: true, optionIndex: best };
  }
  const opts = lastOptions({
    ...s,
    pending: { slot: "listing", proposed: null, kind: "choice", prompt: "" },
  });
  const idx = fuzzyMatchIndex(t, opts);
  if (idx != null) return { ok: true, optionIndex: idx };
  const needle = t.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (needle.length >= 3) {
    const hit = s.listings.findIndex((l) => {
      const bag = `${l.productTitle} ${l.storeName} ${(l.variants ?? [])
        .map((v) => `${v.productTitle} ${v.color ?? ""} ${v.storage ?? ""} ${v.size ?? ""}`)
        .join(" ")}`.toLowerCase();
      return bag.includes(needle);
    });
    if (hit >= 0) return { ok: true, optionIndex: hit };
  }
  return { ok: false };
}

export function parseAgainstPending(s: DialogSession, text: string): PendingParse {
  const pending = requestedSlot(s);
  const t = text.trim();
  if (!pending) return { ok: false };

  // Listing pick is a card (1 / title / price), never a yes-to-search or yes-to-first-SKU.
  if (pending.slot === "listing") {
    return parseListingReply(s, t);
  } else if (pending.slot === "pay" && asksForFreshWallet(t)) {
    return { ok: true, applyProposed: true };
  } else if (/^(y|yes|ok|okay|sure|yeah|yep|yup|fine|that works|sounds good|that one|the first|first one)\b/i.test(t)) {
    return { ok: true, applyProposed: true };
  }

  const opts = lastOptions(s);
  if (pending.kind === "choice" || opts.length) {
    const idx = fuzzyMatchIndex(t, opts);
    if (idx != null) return { ok: true, optionIndex: idx };
  }

  if (pending.kind === "date" || pending.slot === "need_by") {
    const d = parseFuzzyDate(t);
    if (d) return { ok: true, value: d.toISOString() };
  }
  if (pending.kind === "money" || pending.slot === "delivery_fee") {
    const cents = parseUsdCents(t);
    if (cents != null) return { ok: true, value: cents };
  }
  if (pending.slot === "shopping_city") {
    const city = parseShoppingCity(t);
    if (city) return { ok: true, value: city };
  }
  if (pending.slot === "delivery_city") {
    const city = parseDeliveryTown(t) ?? parseTripDestination(t) ?? normalizeCity(t);
    if (city) return { ok: true, value: city };
  }
  if (pending.slot === "destination") {
    const city = parseTripDestination(t);
    if (city) return { ok: true, value: city };
  }
  if (pending.slot === "origin") {
    const city = parseTripOrigin(t) ?? parseTripDestination(t);
    if (city) return { ok: true, value: city };
  }
  if (pending.slot === "product") {
    const url = extractProductUrl(t);
    if (url) return { ok: true, value: url };
    const item = parseItem(t);
    if (item) return { ok: true, value: item };
  }
  if (pending.kind === "bool" || pending.slot === "pay" || pending.slot === "brief" || pending.slot === "shop_opt_in" || pending.slot === "traveler_card") {
    if (/^(n|no|nope|nah)\b/i.test(t)) return { ok: true, value: "no" };
  }
  return { ok: false };
}

function detectRepair(s: DialogSession, text: string): ClassifiedTurn | null {
  const t = text.trim();
  if (!/^(actually|instead|make it|change( it)? to|not)\b/i.test(t)) return null;
  const rest = t
    .replace(/^(actually|instead|make it|change (it )?to|not)[,:\s]+/i, "")
    .trim();
  if (!rest && !/^not\b/i.test(t)) return null;
  const probe = rest || t;
  const open = requestedSlot(s)?.slot;

  if (s.deadline && open !== "need_by") {
    const d = parseFuzzyDate(probe);
    if (d) return { act: "REPAIR", slot: "need_by", value: d.toISOString() };
  }
  if (s.deliveryCity && open !== "delivery_city") {
    const city = parseDeliveryTown(probe) ?? parseTripDestination(probe) ?? normalizeCity(probe);
    if (city) return { act: "REPAIR", slot: "delivery_city", value: city };
  }
  if (s.searchQuery && (open === "origin" || open === "departure_date" || open === "flight")) {
    const dest = parseTripDestination(probe);
    if (dest) return { act: "REPAIR", slot: "destination", value: dest };
  }
  if (s.shoppingCity && s.searchQuery && open !== "shopping_city") {
    const city = parseShoppingCity(probe);
    if (city) return { act: "REPAIR", slot: "shopping_city", value: city };
  }
  if (s.maxFeeCents != null && open !== "delivery_fee") {
    const cents = parseUsdCents(probe);
    if (cents != null) return { act: "REPAIR", slot: "delivery_fee", value: cents };
  }
  if (s.ranked?.length && open !== "traveler") {
    const idx = fuzzyMatchIndex(probe, s.ranked.map((r) => ({ label: r.name, haystack: r.name })));
    if (idx != null) return { act: "REPAIR", slot: "traveler", optionIndex: idx };
  }
  return null;
}

function unmistakableNewItem(s: DialogSession, text: string, hasPhoto: boolean): boolean {
  if (hasPhoto) return true;
  if (isRecapLeftover(s, text)) return false;
  if (s.step === "await_pay_confirm" && asksForFreshWallet(text)) return false;
  const item = parseItem(text);
  if (!item) return false;
  const open = isFormOpen(s);
  const pending = requestedSlot(s);
  if (pending && parseAgainstPending(s, text).ok) return false;
  if (s.listings?.length && parseListingReply(s, text).ok) return false;
  if (s.listings?.length && merchantOnOpenList(s, text)) return false;
  if (!open) return true;
  if (replacementItem(text)) return true;
  return Boolean(categoryOf(item) && item.split(/\s+/).length >= 2);
}

/** Invalid / missing model act → re-ask if a question is open; never NEW. */
export function actFromModel(raw: unknown, s: DialogSession): TurnAct {
  const act = typeof raw === "string" ? raw.toUpperCase() : "";
  if (act === "META" || act === "REPAIR" || act === "CONTINUE" || act === "NEW" || act === "REASK") {
    return act;
  }
  return requestedSlot(s) || isFormOpen(s) ? "REASK" : "REASK";
}

export function classifyTurn(
  s: DialogSession,
  input: { text: string; hasPhoto?: boolean },
): ClassifiedTurn {
  const text = (input.text ?? "").trim();
  const hasPhoto = Boolean(input.hasPhoto);
  const pending = requestedSlot(s);
  const open = isFormOpen(s);

  const meta = text ? isMetaText(text) : null;
  if (meta) return { act: "META", meta };

  if (hasPhoto) return { act: "NEW", query: parseItem(text) || "[photo]" };
  const productUrl = extractProductUrl(text);
  if (productUrl && !(pending && pending.slot !== "product" && parseAgainstPending(s, text).ok)) {
    if (pending?.slot === "product" || !pending) {
      // URL names the item. Open product slot continues; idle is NEW.
      if (pending?.slot === "product") {
        return { act: "CONTINUE", slot: "product", value: productUrl };
      }
      if (!open || replacementItem(text)) return { act: "NEW", query: productUrl };
    }
  }
  const replaced = parseItem(text);
  if (replacementItem(text) && replaced && !(pending && parseAgainstPending(s, text).ok)) {
    const listingHit = parseListingReply(s, text);
    if (listingHit.ok) {
      return {
        act: "CONTINUE",
        slot: "listing",
        value: listingHit.value,
        optionIndex: listingHit.optionIndex,
      };
    }
    return { act: "NEW", query: replaced };
  }

  const newItem = unmistakableNewItem(s, text, hasPhoto);

  const repair = text ? detectRepair(s, text) : null;
  if (repair && open && !newItem) return repair;

  if (pending) {
    const parsed = parseAgainstPending(s, text);
    if (parsed.ok) {
      return {
        act: "CONTINUE",
        slot: pending.slot,
        value: parsed.value,
        optionIndex: parsed.optionIndex,
        query: parsed.applyProposed ? String(pending.proposed ?? "") : undefined,
      };
    }
    if (pending.slot === "listing" && /^(y|yes|ok|okay|sure|yeah|yep|yup|fine|that works|sounds good)\b/i.test(text)) {
      return { act: "REASK" };
    }
    if (pending.slot !== "listing" && s.listings?.length) {
      const listingHit = parseListingReply(s, text);
      if (listingHit.ok) {
        return {
          act: "CONTINUE",
          slot: "listing",
          value: listingHit.value,
          optionIndex: listingHit.optionIndex,
        };
      }
    }
    if (isDependent(text) && /^(y|yes|ok|okay|sure|yeah|yep|yup|fine|that one)\b/i.test(text)) {
      return { act: "CONTINUE", slot: pending.slot, query: String(pending.proposed ?? "") };
    }
    if (newItem && replaced) return { act: "NEW", query: replaced };
    return { act: "REASK" };
  }

  if (newItem && replaced) return { act: "NEW", query: replaced };

  if (open) {
    if (isDependent(text)) return { act: "CONTINUE" };
    return { act: "REASK" };
  }

  if (!text && !hasPhoto) return { act: "REASK" };
  if (isDependent(text) || /^(hi|hello|hey|start|menu)\b/i.test(text)) {
    return { act: "REASK", slot: "product" };
  }
  if (replaced) return { act: "NEW", query: replaced };
  if (productUrl) return { act: "NEW", query: productUrl };
  return { act: "REASK", slot: "product" };
}
