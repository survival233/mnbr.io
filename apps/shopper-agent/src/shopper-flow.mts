import { formatUsd, endOfLocalDay, computeFees, suggestedTravelerFeeCents, generateHandoverCode } from "@manebra/shared";
import { normalizeCity } from "@manebra/calendar";
import { resolveMetro, sameMetro, hubCity } from "@manebra/geo";
import { searchProducts, hasSerpApiKey, NoShopMarketError, formatSkuCardList, listingFromProductUrl, productNameFromUrl, type ProductListing } from "@manebra/catalog";
import { makeLlm, extractOrder } from "@manebra/llm";
import { rankTripsForItem, scoreMatch } from "@manebra/agents/matching/score";
import {
  type Session,
  type Step,
  type DialogOffer,
  type PendingSlot,
  getOrCreateSession,
  resetSession,
  parseDate,
  parseUsdCents,
  categoryOf,
  markSessionDirty,
  persistSessionsNow,
  appendDialogTurn,
  sessionKey,
  allSessions,
} from "./session.mts";
import { classifyIntent, normalizeSearchQuery } from "./intent.mts";
import {
  classifyTurn,
  filledSlotKeys,
  persistBeforeAsk,
  composeHostReply,
  HOSPITALITY_PERSONA,
  SHOPPER_SLOT_SCHEMA,
  ensureStay,
  rememberQuestion,
  rememberItem,
  rememberQuote,
  rememberCounterparty,
  rememberOffer,
  rememberWait,
  parseItem,
  extractProductUrl,
  type ClassifiedTurn,
} from "@manebra/dialog";
import * as linq from "./linq-client.mts";
import * as relay from "./relay-client.mts";
import {
  completeHandoverAndRelease,
} from "./settlement-bridge.mts";
import { demoLocalChain, fundLocalEscrow, settleLocalEscrow } from "@manebra/settlement/server/local-escrow";
import {
  writeOffer,
  updateOffer,
  getOffer,
  listUpcomingTrips,
  getConnectedCard,
} from "@manebra/db";
import {
  briefConfirmCopy,
  canConfirmHeadingYourWay,
  keepLookingCopy,
  nextUntriedIndex,
  noMatchCopy,
  offerTimedOut,
  requestExpiredCopy,
  requestPastDeadline,
  searchingCopy,
  shopperStillWaiting,
  travelerAgreedCopy,
  waitingCopy,
} from "./match-policy.mts";
import { agentcardConfigured } from "@repo/agentcard";
import { PaySheet } from "@repo/agentcard/PaySheet";
import { handleCardTurn, wantsCardTools } from "./agentcard-cards.mts";
import { runPolicyTurn } from "./cognition/policy.mts";
import { appendEpisode, ensureCognition } from "./cognition/state.mts";
import { parseShoppingCity, parseDeliveryTown } from "./cognition/cities.mts";
type TravelerSeed = {
  id: string;
  name: string;
  trustScore: number;
  avgRating: number | null;
  totalDeliveries: number;
  minFeeCents: number;
  trip: {
    id: string;
    travelerId: string;
    direction: "us_to_gh";
    originCity?: string;
    destinationCity: string;
    departureDate: Date;
    status: "upcoming";
  };
  profile: {
    id: string;
    isVerified: boolean;
    accountStatus: "active";
    trustScore: number;
    avgRating: number | null;
    totalDeliveries: number;
  };
};

function stampHub(city: string): string {
  return hubCity(city) ?? resolveMetro(city)?.city ?? city;
}

const ALLOWED = {
  us_to_gh: ["electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable"],
};
const CFG = {
  categoriesByDirection: ALLOWED,
  newUserDeliveryThreshold: 3,
  newUserItemCapCents: 50_000,
  highValueItemCents: 100_000,
  highValueMinTrust: 120,
};

const SERP_TIMEOUT_MS = 12_000;
const ESCROW_TIMEOUT_MS = 45_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function presenceTyping(s: Session) {
  if (!s.chatId) return;
  if (s.channel === "relay") void relay.startTyping(s.chatId);
  else void linq.startTyping(s.chatId);
}

function presenceRead(s: Session) {
  if (!s.chatId) return;
  if (s.channel === "relay") {
    if (s.relayMessageId) void relay.markRead(s.chatId, s.relayMessageId);
  } else {
    void linq.markChatRead(s.chatId);
  }
}

function relayIdempotencyKey(s: Session, text: string, attempt = 0): string {
  // Include a short content tag so a changed body never reuses a prior key (409).
  let tag = 0;
  for (let i = 0; i < text.length; i++) tag = (Math.imul(tag, 33) + text.charCodeAt(i)) >>> 0;
  const base = `reply-${s.relayEventId ?? "na"}-${s.relayReplySeq}-${tag.toString(16)}`;
  return attempt > 0 ? `${base}-r${attempt}` : base;
}

/** Typing bubble + paced send so it feels like a person, not a USSD menu. */
async function reply(s: Session, text: string, opts?: { thinkMs?: number }) {
  if (!text?.trim()) {
    console.warn("[shopper-agent] skip empty reply (Relay rejects blank text)");
    return;
  }
  appendDialogTurn(s, "assistant", text);
  if (s.channel === "relay") {
    if (s.chatId) {
      if (s.relayMessageId) void relay.markRead(s.chatId, s.relayMessageId);
      void relay.startTyping(s.chatId);
    }
    const paced = opts?.thinkMs ?? Math.min(1800, Math.max(350, Math.round(text.length * 18)));
    await sleep(paced);
    if (!s.chatId) throw new Error("relay reply missing conversation id");
    s.relayReplySeq = (s.relayReplySeq ?? 0) + 1;
    const replyTo = s.relayReplySeq === 1 ? s.relayMessageId : null;
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await relay.sendText({
          conversationId: s.chatId,
          text,
          idempotencyKey: relayIdempotencyKey(s, text, attempt),
          replyToMessageId: replyTo,
        });
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        if (!/idempotency_conflict|409/.test(String(e?.message ?? e))) throw e;
        console.warn(`[shopper-agent] relay idempotency conflict; retrying (attempt ${attempt + 1})`);
      }
    }
    if (lastErr) throw lastErr;
    void relay.stopTyping(s.chatId);
    markSessionDirty();
    console.log(`[shopper-agent] → relay ${s.phone}: ${text.slice(0, 80).replace(/\n/g, " ")}`);
    return;
  }

  if (s.chatId) {
    void linq.markChatRead(s.chatId);
    void linq.startTyping(s.chatId);
  }
  const paced = opts?.thinkMs ?? Math.min(1800, Math.max(350, Math.round(text.length * 18)));
  await sleep(paced);
  const out = await linq.sendText({ toPhone: s.phone, chatId: s.chatId, text });
  s.chatId = out.chatId;
  markSessionDirty();
  console.log(`[shopper-agent] → ${s.phone}: ${text.slice(0, 80).replace(/\n/g, " ")}`);
}

void SHOPPER_SLOT_SCHEMA;
void HOSPITALITY_PERSONA;

function stayOf(s: Session) {
  s.stay = ensureStay(s.stay);
  return s.stay;
}

async function sayHost(s: Session, act: ClassifiedTurn["act"], next?: string, meta?: ClassifiedTurn["meta"]) {
  await say(s, ...composeHostReply({ act, meta, stay: stayOf(s), next }));
}

/** 2–3 short bubbles. */
async function say(s: Session, ...bubbles: string[]) {
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i]!;
    if (!b?.trim()) continue;
    await reply(s, b, {
      thinkMs: i === 0 ? 450 + Math.floor(Math.random() * 350) : 550 + Math.floor(Math.random() * 450),
    });
  }
}

async function replyPair(s: Session, first: string, second: string) {
  await say(s, first, second);
}

const DEST_ASK = "Which city should it land in?";

function shopperIntakeLine(s: Session): string {
  return s.channel === "relay"
    ? "What should I shop for you?"
    : "Send a product (text, a store link, or photo) and I’ll find stock and a traveler heading to your city.";
}

function namedProduct(raw: string): string | null {
  const item = parseItem(raw);
  if (!item) return null;
  const q = normalizeSearchQuery(item);
  return parseItem(q) ?? q;
}

function parkItemAsk(s: Session): string {
  const prompt = shopperIntakeLine(s);
  s.step = "await_product";
  s.searchQuery = undefined;
  s.offer = undefined;
  s.pending = { slot: "product", proposed: null, kind: "text", prompt };
  rememberQuestion(stayOf(s), prompt);
  persistBeforeAsk(persistSessionsNow);
  markSessionDirty();
  return prompt;
}

function parkDestAsk(s: Session, prompt = DEST_ASK) {
  s.step = "await_delivery_city";
  s.offer = undefined;
  s.pending = { slot: "delivery_city", proposed: null, kind: "text", prompt };
  rememberQuestion(stayOf(s), prompt);
  persistBeforeAsk(persistSessionsNow);
  markSessionDirty();
}

function commitDeliveryCity(s: Session, raw: string): void {
  const t = raw.trim();
  s.deliveryCity = parseDeliveryTown(t) ?? guestTownSafe(t);
  s.offer = undefined;
  markSessionDirty();
}

function guestTownSafe(raw: string): string {
  return hubCity(raw) ?? resolveMetro(raw)?.city ?? normalizeCity(raw) ?? raw;
}

function isYes(text: string): boolean {
  return /^(y|yes|ok|okay|sure|yeah|yep|yup|that'?s\s+fine|that'?s\s+ok(?:ay)?)\b/i.test(text.trim());
}

/** Never treat these as a product search query. */
function isAffirmationOrCloser(text: string): boolean {
  return /^(y|yes|yeah|yep|yup|ok|okay|sure|that'?s\s+fine|that'?s\s+ok(?:ay)?|n|no|nope|nah)\.?$/i.test(
    text.trim(),
  );
}

/** Affirm / defer-to-agent — apply the last offer, do not parse this utterance as a slot. */
function acceptsOffer(text: string, intent: { kind: string }): boolean {
  if (intent.kind === "yes") return true;
  return /^(y|yes|ok|okay|sure|yeah|yep|yup|affirmative|idk|idc|whatever|you pick|up to you|sounds good|that works|that'?s fine|that'?s ok(?:ay)?|that one|the first|first one|fine)\b/i.test(
    text.trim(),
  );
}

const OFFER_META: Record<
  DialogOffer["field"],
  { slot: PendingSlot["slot"]; kind: PendingSlot["kind"] }
> = {
  shoppingCity: { slot: "shopping_city", kind: "text" },
  deliveryCity: { slot: "delivery_city", kind: "text" },
  deadline: { slot: "need_by", kind: "date" },
  maxFeeCents: { slot: "delivery_fee", kind: "money" },
  listing: { slot: "listing", kind: "choice" },
  traveler: { slot: "traveler", kind: "choice" },
  pay: { slot: "pay", kind: "bool" },
};

function lastChoiceOptions(s: Session, field: DialogOffer["field"]): PendingSlot["options"] {
  if (field === "listing") {
    return (s.listings ?? []).map((l, i) => ({ id: String(i), label: l.storeName }));
  }
  if (field === "traveler") {
    return (s.ranked ?? []).map((r, i) => ({ id: String(i), label: r.name }));
  }
  return s.pending?.options;
}

function setOffer(s: Session, field: DialogOffer["field"], value: string, prompt?: string) {
  s.offer = { field, value };
  const meta = OFFER_META[field];
  const asNum = field === "maxFeeCents" ? parseInt(value, 10) : NaN;
  s.pending = {
    slot: meta.slot,
    proposed: Number.isFinite(asNum) ? asNum : value,
    kind: meta.kind,
    prompt: prompt ?? s.pending?.prompt ?? "",
    options: lastChoiceOptions(s, field),
  };
  rememberQuestion(stayOf(s), s.pending.prompt);
  markSessionDirty();
  persistBeforeAsk(persistSessionsNow);
}

function clearPending(s: Session) {
  s.offer = undefined;
  s.pending = null;
  markSessionDirty();
}

function takeOffer(s: Session, field: DialogOffer["field"]): string | null {
  if (s.offer?.field !== field) return null;
  const v = s.offer.value;
  clearPending(s);
  return v;
}

function isNewShopRequest(text: string, intent: { kind: string }): boolean {
  if (intent.kind === "new_query" || intent.kind === "reject_results") return true;
  return /^(actually\s+i\s+want|different\s+item|start\s+over|search\s+for|look\s+for)\b/i.test(text.trim());
}

function listingLabels(s: Session) {
  return (s.listings ?? []).map((l) => ({
    label: l.storeName,
    haystack: `${l.productTitle} ${l.storeName}`,
  }));
}

function travelerLabels(s: Session) {
  const rows = [...(s.ranked ?? [])];
  if (s.extendCandidate && !rows.some((r) => r.id === s.extendCandidate!.id)) {
    rows.push(s.extendCandidate);
  }
  return rows.map((r) => ({
    label: r.name,
    haystack: `${r.name} ${r.departs}`,
  }));
}

/** Guest-facing date that parseDate can commit on yes. Never a fixed calendar default. */
function guestDate(d: Date): string {
  const n = d.getDate();
  const ord =
    n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${n}${ord} ${months[d.getMonth()]}`;
}

function parseDepartLabel(raw: string | undefined): Date | null {
  if (!raw?.trim()) return null;
  const parsed = parseDate(raw);
  if (parsed) return parsed;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return endOfLocalDay(new Date(ms));
}

function upcomingOnOrAfter(d: Date, now: Date): boolean {
  return d.getTime() > now.getTime();
}

function eligibleLiveTrip(
  t: { destinationCity: string; originCity?: string; departureDate: Date; optedIn?: boolean; status?: string },
  dest: string,
  now: Date,
  origin?: string,
): boolean {
  if (t.optedIn === false) return false;
  if (t.status && t.status !== "upcoming") return false;
  if (!upcomingOnOrAfter(t.departureDate, now)) return false;
  if (!sameMetro(t.destinationCity, dest)) return false;
  if (origin && t.originCity && !sameMetro(t.originCity, origin)) return false;
  return true;
}

async function loadLiveTravelers(city: string, deadline: Date, origin?: string): Promise<TravelerSeed[]> {
  const now = new Date();
  const dest = stampHub(city);
  const home = origin ? stampHub(origin) : undefined;
  try {
    const mkt = (await listUpcomingTrips()).filter((t) =>
      eligibleLiveTrip({ ...t, originCity: t.originCity }, dest, now, home),
    );
    if (mkt.length) {
      return mkt.map((t) => ({
        id: t.travelerId,
        name: t.travelerName,
        trustScore: 120,
        avgRating: null,
        totalDeliveries: 0,
        minFeeCents: 2000,
        trip: {
          id: t.id,
          travelerId: t.travelerId,
          direction: "us_to_gh" as const,
          originCity: t.originCity ? stampHub(t.originCity) : undefined,
          destinationCity: dest,
          departureDate: t.departureDate,
          status: "upcoming" as const,
        },
        profile: {
          id: t.travelerId,
          isVerified: true,
          accountStatus: "active" as const,
          trustScore: 120,
          avgRating: null,
          totalDeliveries: 0,
        },
      }));
    }
  } catch (e: any) {
    console.warn(`[shopper-agent] marketplace trips unavailable: ${e?.message ?? e}`);
  }
  if (!process.env.DATABASE_URL?.trim()) return [];
  try {
    const { prisma } = await import("@manebra/db");
    const trips = await prisma.travelerTrip.findMany({
      where: {
        status: "upcoming",
        departureDate: { gt: now },
      },
      include: { traveler: true },
      take: 40,
      orderBy: { departureDate: "asc" },
    });
    const live = trips.filter((t) =>
      eligibleLiveTrip({ ...t, originCity: t.departureCity }, dest, now, home),
    );
    if (!live.length) return [];
    return live.map((t) => ({
      id: t.travelerId,
      name: t.traveler.fullName,
      trustScore: t.traveler.trustScore,
      avgRating: t.traveler.avgRating == null ? null : Number(t.traveler.avgRating),
      totalDeliveries: t.traveler.totalDeliveries,
      minFeeCents: 2000,
      trip: {
        id: t.id,
        travelerId: t.travelerId,
        direction: "us_to_gh" as const,
        originCity: stampHub(t.departureCity),
        destinationCity: dest,
        departureDate: t.departureDate,
        status: "upcoming" as const,
      },
      profile: {
        id: t.travelerId,
        isVerified: t.traveler.isVerified,
        accountStatus: "active" as const,
        trustScore: t.traveler.trustScore,
        avgRating: t.traveler.avgRating == null ? null : Number(t.traveler.avgRating),
        totalDeliveries: t.traveler.totalDeliveries,
      },
    }));
  } catch (e: any) {
    console.warn(`[shopper-agent] live travelers unavailable: ${e?.message ?? e}`);
    return [];
  }
}

/** Live opted-in upcoming trips whose arrival hub matches the shopper's town. Seeds only if none. */
async function upcomingToDest(city: string, origin?: string): Promise<TravelerSeed[]> {
  const now = new Date();
  if (!resolveMetro(city)) return [];
  const dest = stampHub(city);
  const home = origin ? stampHub(origin) : undefined;
  let live: TravelerSeed[] = [];
  try {
    live = (await listUpcomingTrips())
      .filter((t) =>
        eligibleLiveTrip({ ...t, originCity: t.originCity }, dest, now, home),
      )
      .map((t) => ({
        id: t.travelerId,
        name: t.travelerName,
        trustScore: 120,
        avgRating: null,
        totalDeliveries: 0,
        minFeeCents: 2000,
        trip: {
          id: t.id,
          travelerId: t.travelerId,
          direction: "us_to_gh" as const,
          originCity: t.originCity ? stampHub(t.originCity) : undefined,
          destinationCity: dest,
          departureDate: t.departureDate,
          status: "upcoming" as const,
        },
        profile: {
          id: t.travelerId,
          isVerified: true,
          accountStatus: "active" as const,
          trustScore: 120,
          avgRating: null,
          totalDeliveries: 0,
        },
      }));
  } catch (e: any) {
    console.warn(`[shopper-agent] upcoming trips unavailable: ${e?.message ?? e}`);
  }
  return live
    .filter((t) => eligibleLiveTrip(t.trip, dest, now, home))
    .sort((a, b) => a.trip.departureDate.getTime() - b.trip.departureDate.getTime());
}

function commitNeedBy(s: Session, raw: string | Date): boolean {
  const d = raw instanceof Date ? raw : parseDepartLabel(raw);
  if (!d || Number.isNaN(d.getTime())) return false;
  s.deadline = endOfLocalDay(d);
  s.extendCandidate = undefined;
  clearPending(s);
  markSessionDirty();
  return true;
}

async function commitStretch(s: Session): Promise<boolean> {
  const alt = s.extendCandidate;
  if (!alt) return false;
  const fromLabel = parseDepartLabel(alt.departs);
  if (fromLabel) return commitNeedBy(s, fromLabel);
  const dest = s.deliveryCity ?? "";
  const trips = dest ? await upcomingToDest(dest) : [];
  const t = trips.find((x) => x.id === alt.id);
  if (!t) return false;
  return commitNeedBy(s, t.trip.departureDate);
}

function dateAskPrompt(dest: string, proposed: string | null): string {
  if (proposed) {
    return `When do you need it by at most? There’s a trip to ${dest} on ${proposed} — say yes, or send another date.`;
  }
  return "When do you need it by at most? Send a date.";
}

async function askNeedBy(s: Session, act?: ClassifiedTurn["act"]): Promise<void> {
  s.step = "await_deadline";
  const dest = s.deliveryCity ?? "";
  const trips = dest ? await upcomingToDest(s.deliveryCity ?? dest) : [];
  const proposed = trips[0] ? guestDate(trips[0].trip.departureDate) : null;
  const prompt = dateAskPrompt(s.deliveryCity || dest || "your city", proposed);
  if (proposed) {
    setOffer(s, "deadline", proposed, prompt);
    const seen = new Set<string>();
    const options: { id: string; label: string }[] = [];
    for (const t of trips) {
      const label = guestDate(t.trip.departureDate);
      if (seen.has(label)) continue;
      seen.add(label);
      options.push({ id: t.id, label });
      if (options.length >= 3) break;
    }
    if (s.pending) s.pending.options = options;
  } else {
    s.offer = undefined;
    s.pending = { slot: "need_by", proposed: null, kind: "date", prompt };
    rememberQuestion(stayOf(s), prompt);
    persistBeforeAsk(persistSessionsNow);
  }
  markSessionDirty();
  await sayHost(s, act ?? stayOf(s).lastAct ?? "CONTINUE", prompt);
}

async function runMatching(s: Session): Promise<string> {
  const selected = s.selected!;
  const city = s.deliveryCity!;
  const deadline = endOfLocalDay(s.deadline!);
  const category = s.category ?? categoryOf(selected.productTitle) ?? "electronics";
  const dest = stampHub(city);
  const live = await loadLiveTravelers(city, deadline);
  const now = new Date();
  const tried = new Set(s.triedTravelerIds ?? []);
  const travelers = live.filter((t) => eligibleLiveTrip(t.trip, dest, now) && !tried.has(t.id));
  const itemRequest = {
    id: "item-linq",
    direction: "us_to_gh" as const,
    destinationCity: dest,
    category,
    itemCostCents: selected.priceCents,
    status: "open" as const,
    reviewStatus: "auto_approved" as const,
    expiresAt: deadline,
  };
  const scored = travelers.map((t) => ({
    t,
    r: scoreMatch(itemRequest as any, t.trip as any, t.profile as any, CFG as any, now),
  }));
  const ranked = rankTripsForItem(
    itemRequest as any,
    travelers.map((t) => ({ trip: t.trip as any, traveler: t.profile as any })),
    CFG as any,
    now,
  );

  const dateAlts = scored
    .filter(
      ({ r }) =>
        !r.eligible &&
        r.reasons.includes("departs_after_item_expiry") &&
        r.reasons.every((x) => x === "departs_after_item_expiry"),
    )
    .sort((a, b) => a.t.trip.departureDate.getTime() - b.t.trip.departureDate.getTime());

  if (ranked.length === 0 && dateAlts.length > 0) {
    const next = dateAlts[0]!;
    s.extendCandidate = {
      id: next.t.id,
      name: next.t.name,
      score: 0,
      departs: guestDate(next.t.trip.departureDate),
    };
    s.step = "await_extend";
    markSessionDirty();
    return (
      `Hmm — nobody’s flying before ${deadline.toDateString()}.\n` +
      `There’s a trip on ${next.t.trip.departureDate.toDateString()} though.\n` +
      `Want me to stretch your deadline to meet it? Just say yes or no.`
    );
  }

  if (ranked.length === 0) {
    s.ranked = [];
    markSessionDirty();
    return "";
  }

  s.ranked = ranked.map((r) => {
    const t = travelers.find((x) => x.id === r.traveler.id)!;
    return {
      id: t.id,
      name: t.name,
      score: r.score,
      departs: guestDate(t.trip.departureDate),
    };
  });
  markSessionDirty();
  return "";
}

function quoteLines(s: Session): string {
  const item = s.selected!;
  const fee = suggestedTravelerFeeCents(item.priceCents);
  const capped = Math.min(fee, s.maxFeeCents ?? fee);
  const fees = computeFees(item.priceCents, capped);
  s.totalCents = fees.totalCents;
  markSessionDirty();
  return (
    `${item.productTitle.slice(0, 80)}\n` +
    `Item ${formatUsd(item.priceCents)} + traveler earnings ${formatUsd(capped)} → ${formatUsd(fees.totalCents)} all-in`
  );
}

/** After the quote: wait on a traveler. No payment copy. */
async function presentQuoteAndWait(s: Session): Promise<void> {
  const matchText = await runMatching(s);
  // Only park on extend when matching just produced that prompt. A leftover
  // await_extend after the shopper said yes must continue to recap + wait
  // (success returns "" and used to POST empty text → Relay 422).
  if (s.step === "await_extend" && matchText.trim()) {
    const altDay = parseDepartLabel(s.extendCandidate?.departs);
    if (altDay && s.deadline && endOfLocalDay(s.deadline).getTime() >= altDay.getTime()) {
      // Already committed this stretch — recap, do not re-ask.
    } else {
      const proposed = s.extendCandidate?.departs;
      if (proposed) setOffer(s, "deadline", proposed, matchText);
      else {
        s.pending = { slot: "brief", proposed: "yes", kind: "bool", prompt: matchText };
        rememberQuestion(stayOf(s), matchText);
      }
      persistSessionsNow();
      await reply(s, matchText, { thinkMs: 1400 });
      return;
    }
  }
  const quote = quoteLines(s);
  rememberItem(stayOf(s), s.selected?.productTitle ?? s.searchQuery ?? "");
  if (s.totalCents) rememberQuote(stayOf(s), s.totalCents);
  const city = handoverCity(s);
  if (s.ranked?.length) {
    await say(s, quote, searchingCopy(city));
    await lockTraveler(s, 0, { quoteAlreadyShown: true, silent: true });
    return;
  }
  await parkOpenRequest(s);
  await say(s, quote, noMatchCopy(city));
}

async function continueAfterListing(s: Session): Promise<void> {
  if (!s.deliveryCity) {
    parkDestAsk(s);
    await say(s, `Nice — ${s.selected!.storeName}, ${formatUsd(s.selected!.priceCents)}.`, DEST_ASK);
    return;
  }
  if (!s.deadline) {
    await askNeedBy(s);
    return;
  }
  if (s.maxFeeCents == null) {
    s.step = "await_max_fee";
    setOffer(
      s,
      "maxFeeCents",
      "3000",
      "What’s the most you’d pay the traveler in USD? $30 is a common cap — say that’s fine, or send a number.",
    );
    markSessionDirty();
    await sayHost(
      s,
      stayOf(s).lastAct ?? "CONTINUE",
      `What’s the most you’d pay the traveler in USD? $30 is a common cap — say that’s fine, or send a number.`,
    );
    return;
  }
  if (s.chatId) presenceTyping(s);
  await presentQuoteAndWait(s);
}

async function searchAndPromptListings(s: Session): Promise<string> {
  if (!hasSerpApiKey()) {
    s.step = "done";
    markSessionDirty();
    return "Store search isn’t hooked up on my side yet — try again later?";
  }
  const q = s.searchQuery!;
  try {
    const results = await withTimeout(
      searchProducts({ query: q, shoppingCity: s.shoppingCity || undefined }),
      SERP_TIMEOUT_MS,
      "SerpAPI search",
    );
    s.listings = results.listings.slice(0, 5);
  } catch (e: any) {
    console.warn(`[shopper-agent] search failed: ${e?.message ?? e}`);
    s.step = "await_product";
    markSessionDirty();
    if (e instanceof NoShopMarketError) {
      return `Store search hiccupped on that market. Want to try a different product name?`;
    }
    return `Search hiccupped on me. What should I look for instead?`;
  }
  if (!s.listings?.length) {
    s.step = "await_product";
    markSessionDirty();
    return "Nothing solid from verified stores. Want to try a different product name?";
  }
  s.step = "await_listing";
  setOffer(s, "listing", "0");
  markSessionDirty();
  const cards = formatSkuCardList(s.listings);
  return (
    `Found a few good ones — any of these catch your eye?\n\n${cards}\n\n` +
    `Pick one (1–${s.listings.length} or a store name), or tell me if these aren’t right / what to search instead.`
  );
}

async function runSearchFlow(s: Session, progress?: string): Promise<void> {
  s.selected = undefined;
  s.listings = undefined;
  s.step = "await_listing";
  markSessionDirty();
  if (progress) await reply(s, progress, { thinkMs: 700 });
  else {
    await reply(s, `One sec — checking verified stores…`, { thinkMs: 700 });
  }
  if (s.chatId) presenceTyping(s);
  await reply(s, await searchAndPromptListings(s), { thinkMs: 1200 });
}

async function presentUrlCard(s: Session, listing: ProductListing): Promise<void> {
  s.listings = [listing];
  s.searchQuery = listing.productTitle;
  s.selected = undefined;
  s.step = "await_listing";
  setOffer(s, "listing", "0");
  rememberItem(stayOf(s), listing.productTitle);
  markSessionDirty();
  const cards = formatSkuCardList([listing]);
  await say(
    s,
    `Got the listing.`,
    `${cards}\n\nSay yes if that’s the one, or send another link / product name.`,
  );
}

async function intakeProductUrl(s: Session, url: string): Promise<void> {
  await reply(s, `One sec — pulling that listing…`, { thinkMs: 500 });
  const listing = await listingFromProductUrl(url);
  if (listing && listing.productTitle && listing.imageUrl) {
    if (listing.priceCents > 0) {
      await presentUrlCard(s, listing);
      return;
    }
    const q = namedProduct(listing.productTitle) ?? listing.productTitle;
    s.searchQuery = q;
    rememberItem(stayOf(s), q);
    await runSearchFlow(s, `Got the page — searching ${q} in verified stores…`);
    return;
  }
  const fallback = productNameFromUrl(url);
  const item = fallback ? namedProduct(fallback) ?? fallback : null;
  if (!item) {
    await sayHost(s, "REASK", parkItemAsk(s));
    return;
  }
  s.searchQuery = item;
  rememberItem(stayOf(s), item);
  await runSearchFlow(s, `Couldn’t read that page — searching ${item}…`);
}

async function applyNewQuery(s: Session, query: string): Promise<void> {
  const url = extractProductUrl(query);
  if (url) {
    await intakeProductUrl(s, url);
    return;
  }
  const item = namedProduct(query);
  if (!item) {
    await sayHost(s, "REASK", parkItemAsk(s));
    return;
  }
  s.searchQuery = item;
  s.selected = undefined;
  s.listings = undefined;
  markSessionDirty();
  rememberItem(stayOf(s), item);
  await runSearchFlow(s, `Got it — searching ${item}…`);
}

async function selectListing(s: Session, idx: number): Promise<void> {
  const list = s.listings ?? [];
  s.selected = list[idx]!;
  s.category ??= categoryOf(s.selected.productTitle) ?? undefined;
  clearPending(s);
  markSessionDirty();
  await continueAfterListing(s);
}

const FORM_HOLD = new Set([
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
]);

function hydratePending(s: Session): void {
  if (s.pending?.slot) return;
  if (s.offer) {
    setOffer(s, s.offer.field, s.offer.value);
    return;
  }
  if (s.step === "await_deadline") {
    s.pending = {
      slot: "need_by",
      proposed: null,
      kind: "date",
      prompt: s.pending?.prompt || dateAskPrompt(s.deliveryCity ?? "your city", null),
    };
  } else if (s.step === "await_extend" && s.extendCandidate) {
    setOffer(
      s,
      "deadline",
      s.extendCandidate.departs,
      s.pending?.prompt || `Want me to stretch your deadline to meet ${s.extendCandidate.name}? Just say yes or no.`,
    );
  } else if (s.step === "await_max_fee") {
    setOffer(
      s,
      "maxFeeCents",
      String(s.maxFeeCents ?? 3000),
      "What’s the most you’d pay the traveler in USD? $30 is a common cap — say that’s fine, or send a number.",
    );
  } else if (s.step === "await_delivery_city") {
    if (s.deliveryCity) setOffer(s, "deliveryCity", s.deliveryCity, DEST_ASK);
    else parkDestAsk(s);
  } else if (s.step === "await_product") {
    if (!s.pending?.slot) parkItemAsk(s);
  } else if (s.step === "await_listing" && s.listings?.length) {
    setOffer(s, "listing", "0", s.pending?.prompt);
  } else if (s.step === "await_traveler" && s.ranked?.length) {
    setOffer(s, "traveler", "0", s.pending?.prompt);
  }
}

function reaskPrompt(s: Session): string {
  return (
    s.pending?.prompt?.trim() ||
    (s.step === "await_deadline"
      ? dateAskPrompt(s.deliveryCity ?? "your city", s.offer?.field === "deadline" ? s.offer.value : null)
      : s.step === "await_max_fee"
        ? "Send a dollar amount, or say that’s fine for $30."
        : s.step === "await_delivery_city"
          ? DEST_ASK
          : s.step === "await_shopping_city"
            ? DEST_ASK
            : s.step === "await_product"
              ? shopperIntakeLine(s)
            : s.step === "await_listing"
              ? `Pick one (1–${s.listings?.length ?? 1} or a store name), or tell me if these aren’t right.`
              : s.step === "await_traveler"
                ? `Pick a traveler — a name or number from 1 to ${s.ranked?.length ?? 1}.`
                : s.step === "await_traveler_decision"
                  ? waitingCopy(s.deliveryCity ?? "your city")
                  : s.step === "await_pay_confirm"
                    ? `Say yes when you’re ready to lock ${formatUsd(s.totalCents ?? 0)} test USDC.`
                    : s.pending?.prompt || "Say yes to the suggestion, or send the value.")
  );
}

async function reaskOpen(s: Session): Promise<void> {
  hydratePending(s);
  persistSessionsNow();
  await sayHost(s, stayOf(s).lastAct ?? "REASK", reaskPrompt(s));
}

function applyRepairSlots(s: Session, turn: ClassifiedTurn): void {
  if (turn.slot === "need_by" && typeof turn.value === "string") {
    const d = parseDate(turn.value) ?? new Date(turn.value);
    if (!Number.isNaN(d.getTime())) s.deadline = d;
  } else if (turn.slot === "delivery_city" && typeof turn.value === "string") {
    s.deliveryCity = turn.value;
  } else if (turn.slot === "shopping_city" && typeof turn.value === "string") {
    s.shoppingCity = turn.value;
  } else if (turn.slot === "delivery_fee" && typeof turn.value === "number") {
    s.maxFeeCents = turn.value;
  } else if (turn.slot === "traveler" && turn.optionIndex != null && s.ranked?.[turn.optionIndex]) {
    s.chosenTravelerId = s.ranked[turn.optionIndex]!.id;
  }
  markSessionDirty();
}

async function handleMetaTurn(s: Session, turn: ClassifiedTurn): Promise<void> {
  if (turn.meta === "cancel") {
    await abandonOpenRequest(s);
    resetSession(s);
    s.step = "await_product";
    persistSessionsNow();
    await sayHost(s, "META", shopperIntakeLine(s), "cancel");
    return;
  }
  if (s.step === "await_traveler_decision") {
    void syncWaitingShoppers();
    rememberWait(stayOf(s));
    await sayHost(s, "META", waitingCopy(handoverCity(s)), turn.meta);
    return;
  }
  hydratePending(s);
  persistSessionsNow();
  await sayHost(s, "META", s.pending?.prompt || reaskPrompt(s), turn.meta);
}

/** Resolve the open question before search/matching. Returns true if this turn is done. */
async function resolveOpenQuestion(s: Session, text: string, intent: { kind: string }): Promise<boolean> {
  if (!FORM_HOLD.has(s.step) && !s.pending && !s.offer) return false;
  if (isNewShopRequest(text, intent)) return false;

  hydratePending(s);

  const greeting = /^(hi|hello|hey|start|menu)\b[,!.\s]*$/i.test(text);
  if (greeting) {
    const prompt = s.pending?.prompt?.trim();
    await reply(s, prompt || s.pending?.prompt || "Say yes to the suggestion, or send the value.");
    return true;
  }

  if (await applyDialogAffirm(s, text, intent)) return true;

  if (s.step === "await_deadline") {
    const d = parseDate(text);
    if (d) {
      s.deadline = d;
      clearPending(s);
      await continueAfterListing(s);
      return true;
    }
    await reply(s, s.pending?.prompt || dateAskPrompt(s.deliveryCity ?? "your city", s.offer?.field === "deadline" ? s.offer.value : null));
    return true;
  }

  if (s.step === "await_max_fee") {
    if (/\b(cheap|cheaper|less|lower|reduce|too much)\b/i.test(text)) return false;
    const cents = parseUsdCents(text);
    if (cents != null) {
      s.maxFeeCents = cents;
      clearPending(s);
      if (s.chatId) presenceTyping(s);
      await presentQuoteAndWait(s);
      return true;
    }
    await reply(
      s,
      s.pending?.prompt || "Send a dollar amount, or say that’s fine for $30.",
    );
    return true;
  }

  return false;
}

/** “yeah” / “that one” / “idk” apply the last offered slot. Matching never sees raw chat. */
async function applyDialogAffirm(s: Session, text: string, intent: { kind: string }): Promise<boolean> {
  if (s.step === "await_extend" && acceptsOffer(text, intent)) {
    if (await commitStretch(s)) {
      await continueAfterListing(s);
      return true;
    }
  }
  if (s.step === "await_brief_confirm" && acceptsOffer(text, intent)) {
    await parkWaitingOnTraveler(s);
    return true;
  }
  if (s.step === "await_traveler_decision" && acceptsOffer(text, intent) && s.offer?.field === "traveler") {
    const idx = parseInt(s.offer.value, 10);
    if (s.ranked?.[idx]) {
      await lockTraveler(s, idx);
      return true;
    }
  }
  if (s.step === "await_pay_confirm" && acceptsOffer(text, intent)) {
    if (s.paySheetSent) {
      await reply(s, `Open the pay link I sent — I’ll lock it once your card is on file.`);
      return true;
    }
    await fundAfterAccept(s);
    return true;
  }
  if (!acceptsOffer(text, intent) || !s.offer) return false;
  const { field } = s.offer;
  const matches =
    (field === "shoppingCity" && s.step === "await_shopping_city") ||
    (field === "deliveryCity" && s.step === "await_delivery_city") ||
    (field === "deadline" && (s.step === "await_deadline" || s.step === "await_extend")) ||
    (field === "maxFeeCents" && s.step === "await_max_fee") ||
    (field === "listing" && s.step === "await_listing") ||
    (field === "traveler" && s.step === "await_traveler");
  if (!matches) return false;

  const value = takeOffer(s, field);
  if (value == null) return false;

  if (field === "shoppingCity") {
    s.shoppingCity = value;
    markSessionDirty();
    await runSearchFlow(s);
    return true;
  }
  if (field === "deliveryCity") {
    commitDeliveryCity(s, value);
    await continueAfterListing(s);
    return true;
  }
  if (field === "deadline") {
    if (!commitNeedBy(s, value)) return false;
    await continueAfterListing(s);
    return true;
  }
  if (field === "maxFeeCents") {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return false;
    s.maxFeeCents = n;
    markSessionDirty();
    if (s.chatId) presenceTyping(s);
    await presentQuoteAndWait(s);
    return true;
  }
  if (field === "listing") {
    const idx = parseInt(value, 10);
    if (!s.listings?.[idx]) return false;
    await selectListing(s, idx);
    return true;
  }
  if (field === "traveler") {
    const idx = parseInt(value, 10);
    const ranked = s.ranked ?? [];
    if (!ranked[idx]) return false;
    await lockTraveler(s, idx);
    return true;
  }
  return false;
}

function handoverCity(s: Session): string {
  return s.deliveryCity ?? "your city";
}

function markTried(s: Session, id: string | undefined): void {
  if (!id) return;
  const next = [...(s.triedTravelerIds ?? [])];
  if (!next.includes(id)) next.push(id);
  s.triedTravelerIds = next;
  markSessionDirty();
}

async function closeOffer(id: string | undefined, status: "declined" | "cancelled" | "expired"): Promise<void> {
  if (!id) return;
  try {
    const o = await getOffer(id);
    if (!o) return;
    if (o.status === "offered" || o.status === "accepted") {
      await updateOffer(id, { status, notifiedShopper: true });
    }
  } catch (e: any) {
    console.warn(`[shopper-agent] close offer skipped: ${e?.message ?? e}`);
  }
}

async function abandonOpenRequest(s: Session): Promise<void> {
  await closeOffer(s.bidId, "cancelled");
}

async function parkOpenRequest(s: Session): Promise<void> {
  s.step = "await_traveler_decision";
  s.chosenTravelerId = undefined;
  clearPending(s);
  rememberItem(stayOf(s), s.selected?.productTitle ?? s.searchQuery ?? "");
  if (s.totalCents) rememberQuote(stayOf(s), s.totalCents);
  rememberWait(stayOf(s));
  rememberQuestion(stayOf(s), noMatchCopy(handoverCity(s)));
  persistBeforeAsk(persistSessionsNow);
  markSessionDirty();
}

async function lockTraveler(
  s: Session,
  idx: number,
  opts?: { quoteAlreadyShown?: boolean; silent?: boolean },
): Promise<void> {
  const ranked = s.ranked ?? [];
  const chosen = ranked[idx];
  if (!chosen) return;
  if (s.bidId && s.chosenTravelerId && s.chosenTravelerId !== chosen.id) {
    await closeOffer(s.bidId, "expired");
    s.bidId = undefined;
  }
  s.chosenTravelerId = chosen.id;
  const item = s.selected!;
  const fee = suggestedTravelerFeeCents(item.priceCents);
  const capped = Math.min(fee, s.maxFeeCents ?? fee);
  const fees = computeFees(item.priceCents, capped);
  s.totalCents = fees.totalCents;
  markSessionDirty();
  if (!opts?.quoteAlreadyShown && !opts?.silent) {
    await say(s, quoteLines(s));
  }
  await parkWaitingOnTraveler(s, { silent: Boolean(opts?.silent) });
}

function travelerDisplayName(s: Session, fallback = "The traveler"): string {
  return (s.ranked ?? []).find((t) => t.id === s.chosenTravelerId)?.name ?? fallback;
}

function acceptedNoFundCopy(travelerName: string): string {
  return `${travelerName} accepted. Funding isn’t available on this host yet — I’ll keep the order as accepted.`;
}

async function parkWaitingOnTraveler(s: Session, opts?: { silent?: boolean }): Promise<void> {
  const chosen = (s.ranked ?? []).find((t) => t.id === s.chosenTravelerId);
  const item = s.selected!;
  const city = handoverCity(s);
  const id = `req-${sessionKey(s.phone)}-${Date.now()}`;
  s.bidId = id;
  s.step = "await_traveler_decision";
  rememberItem(stayOf(s), item.productTitle);
  if (s.totalCents) rememberQuote(stayOf(s), s.totalCents);
  rememberOffer(stayOf(s), id);
  rememberWait(stayOf(s));
  rememberQuestion(stayOf(s), searchingCopy(city));
  clearPending(s);
  persistBeforeAsk(persistSessionsNow);
  try {
    const fee = suggestedTravelerFeeCents(item.priceCents);
    const capped = Math.min(fee, s.maxFeeCents ?? fee);
    const nextIdx = nextUntriedIndex(s.ranked ?? [], [...(s.triedTravelerIds ?? []), s.chosenTravelerId ?? ""]);
    const next = nextIdx != null ? (s.ranked ?? [])[nextIdx] : undefined;
    await writeOffer({
      id,
      travelerId: s.chosenTravelerId!,
      travelerName: chosen?.name ?? "Traveler",
      item: item.productTitle.slice(0, 80),
      itemCostCents: item.priceCents,
      travelerFeeCents: capped,
      totalCents: s.totalCents ?? 0,
      needBy: s.deadline ?? null,
      destinationCity: s.deliveryCity ?? null,
      bidId: id,
      escrowId: "",
      handoverCode: "",
      status: "offered",
      shopperKey: sessionKey(s.phone),
      shopperChatId: s.chatId,
      notifiedShopper: false,
      notifiedTraveler: false,
      notifiedTravelerFunded: false,
      nextTravelerId: next?.id,
      nextTravelerName: next?.name,
    });
  } catch (e: any) {
    console.warn(`[shopper-agent] marketplace offer skipped: ${e?.message ?? e}`);
  }
  if (!opts?.silent) {
    await say(s, searchingCopy(city));
  }
}

async function advanceAfterTravelerMiss(s: Session, reason: "declined" | "expired"): Promise<void> {
  markTried(s, s.chosenTravelerId);
  await closeOffer(s.bidId, reason);
  s.bidId = undefined;
  s.chosenTravelerId = undefined;
  const idx = nextUntriedIndex(s.ranked ?? [], s.triedTravelerIds ?? []);
  if (idx != null) {
    await lockTraveler(s, idx, { quoteAlreadyShown: true, silent: true });
    return;
  }
  await parkOpenRequest(s);
  await say(s, keepLookingCopy(handoverCity(s)));
}

async function tryRematchWaiting(s: Session): Promise<void> {
  if (!s.selected || !s.deliveryCity || !s.deadline) return;
  await runMatching(s);
  const idx = nextUntriedIndex(s.ranked ?? [], s.triedTravelerIds ?? []);
  if (idx == null) return;
  await lockTraveler(s, idx, { quoteAlreadyShown: true, silent: true });
}

async function notifyShopperAccepted(s: Session, travelerName: string, totalCents: number): Promise<void> {
  const city = handoverCity(s);
  rememberCounterparty(stayOf(s), travelerName, s.chosenTravelerId);
  await say(s, travelerAgreedCopy(travelerName, city));
  if (agentcardConfigured()) {
    const opened = await openPaySheetAfterAccept(s, totalCents);
    if (opened) return;
  }
  if (demoLocalChain()) {
    s.step = "await_pay_confirm";
    setOffer(
      s,
      "pay",
      "yes",
      `Lock ${formatUsd(totalCents)} test USDC in escrow for this request?`,
    );
    await say(s, `Fund ${formatUsd(totalCents)} USDC to lock it.`);
  } else {
    console.warn("[shopper-agent] payment stub: no local escrow on this host (Relay logs only)");
    clearPending(s);
    await say(s, acceptedNoFundCopy(travelerName));
  }
}

/** Hosted pay-sheet after accept. Amount is the recap total — do not recompute. */
async function openPaySheetAfterAccept(s: Session, recapTotalCents: number): Promise<boolean> {
  try {
    const sheet = await PaySheet({
      identity: sessionKey(s.phone),
      amountCents: recapTotalCents,
      merchant: "Manebra",
    });
    s.step = "await_pay_confirm";
    s.paySheetSent = true;
    s.paySheetAmountCents = sheet.amountCents;
    s.offer = undefined;
    s.pending = {
      slot: "pay",
      proposed: sheet.amountCents,
      kind: "bool",
      prompt: `Fund ${formatUsd(sheet.amountCents)} with your card.`,
    };
    markSessionDirty();
    await say(
      s,
      `Fund ${formatUsd(sheet.amountCents)} with your card (4242… if you still need to add one).`,
      sheet.url,
    );
    return true;
  } catch (e: any) {
    console.warn(`[shopper-agent] pay-sheet: ${e?.message ?? e}`);
    return false;
  }
}

async function maybeCompleteAgentCardFund(s: Session): Promise<boolean> {
  if (s.step !== "await_pay_confirm" || !s.paySheetSent || s.handoverCode || s.escrowId) return false;
  const card = await getConnectedCard(sessionKey(s.phone));
  if (!card) return false;
  await fundAfterAccept(s);
  return true;
}

/** When Traveler accepts/declines, ping waiting Shopper (same process as Relay long-poll). */
export async function syncWaitingShoppers(): Promise<void> {
  for (const s of allSessions()) {
    if ((s.step === "await_pay_confirm" || s.step === "await_traveler_decision") && s.bidId) {
      if (await maybeCompleteAgentCardFund(s)) continue;
    }
    if (s.step !== "await_traveler_decision") continue;

    if (requestPastDeadline(s.deadline ? endOfLocalDay(s.deadline) : undefined)) {
      await closeOffer(s.bidId, "expired");
      s.step = "done";
      s.bidId = undefined;
      s.chosenTravelerId = undefined;
      clearPending(s);
      markSessionDirty();
      await say(s, requestExpiredCopy(handoverCity(s)));
      continue;
    }

    if (!s.bidId) {
      await tryRematchWaiting(s);
      continue;
    }

    const carry = await getOffer(s.bidId);
    if (!carry) {
      await tryRematchWaiting(s);
      continue;
    }

    if (carry.status === "offered" && offerTimedOut(carry.createdAt)) {
      await advanceAfterTravelerMiss(s, "expired");
      continue;
    }

    if (carry.status === "accepted") {
      if (
        !canConfirmHeadingYourWay({
          offerStatus: carry.status,
          shopperWaiting: shopperStillWaiting(s.step, s.bidId, carry.id),
        })
      ) {
        await closeOffer(carry.id, "cancelled");
        continue;
      }
      if (carry.notifiedShopper) continue;
      await updateOffer(carry.id, { notifiedShopper: true });
      await notifyShopperAccepted(s, carry.travelerName, carry.totalCents);
      continue;
    }

    if (carry.status === "declined" || carry.status === "expired") {
      if (carry.notifiedShopper) continue;
      await updateOffer(carry.id, { notifiedShopper: true });
      await advanceAfterTravelerMiss(s, carry.status === "expired" ? "expired" : "declined");
      continue;
    }
  }
}

function escrowErrorForUser(e: unknown): string {
  const msg = String((e as any)?.message ?? e);
  if (/insufficient|balance/i.test(msg)) return `Couldn't lock escrow — balance is too low. ${msg}`;
  if (/allowance|authorization/i.test(msg)) return `Couldn't lock escrow — allowance failed. ${msg}`;
  if (/revert|contract|USDC_ADDRESS|HANDOVER_ESCROW/i.test(msg)) {
    return `Couldn't lock escrow — contract error. ${msg}`;
  }
  return `Couldn't lock escrow. ${msg}`;
}

async function fundAfterAccept(s: Session): Promise<void> {
  if (!demoLocalChain() && agentcardConfigured() && s.paySheetSent) {
    const item = s.selected!;
    const fee = suggestedTravelerFeeCents(item.priceCents);
    const capped = Math.min(fee, s.maxFeeCents ?? fee);
    const recapTotal = s.totalCents ?? s.paySheetAmountCents ?? computeFees(item.priceCents, capped).totalCents;
    const code = generateHandoverCode();
    s.handoverCode = code;
    s.totalCents = recapTotal;
    s.step = "await_handover_done";
    s.offer = undefined;
    s.pending = null;
    markSessionDirty();
    if (s.bidId) {
      await updateOffer(s.bidId, {
        handoverCode: code,
        totalCents: recapTotal,
        status: "funded",
        notifiedShopper: true,
        notifiedTravelerFunded: false,
      });
    }
    await say(
      s,
      `Funded — ${formatUsd(recapTotal)}.`,
      `Your handover code is ${code}. Give that to the traveler when you meet and you’ve checked the item.`,
    );
    return;
  }
  if (!demoLocalChain()) {
    console.warn("[shopper-agent] payment stub: no local escrow on this host (Relay logs only)");
    await reply(s, acceptedNoFundCopy(travelerDisplayName(s)));
    return;
  }
  await reply(s, `Opening escrow… one moment.`, { thinkMs: 600 });
  try {
    if (s.chatId) presenceTyping(s);
    const item = s.selected!;
    const fee = suggestedTravelerFeeCents(item.priceCents);
    const capped = Math.min(fee, s.maxFeeCents ?? fee);
    const requestId = s.bidId;
    const out = await withTimeout(
      fundLocalEscrow({
        shopperUserId: s.phone,
        travelerId: s.chosenTravelerId!,
        itemCostCents: item.priceCents,
        travelerFeeCents: capped,
      }),
      ESCROW_TIMEOUT_MS,
      "escrow fund",
    );
    s.escrowId = out.escrowId;
    s.handoverCode = out.handoverCode;
    s.fundTxHash = out.fundTxHash;
    s.totalCents = out.totalCents;
    s.step = "await_handover_done";
    s.offer = undefined;
    s.pending = null;
    markSessionDirty();
    if (requestId) {
      await updateOffer(requestId, {
        escrowId: out.escrowId,
        handoverCode: out.handoverCode,
        totalCents: out.totalCents,
        status: "funded",
        notifiedShopper: true,
        notifiedTravelerFunded: false,
      });
    }
    await say(
      s,
      `Funded — ${formatUsd(out.totalCents)} in escrow.`,
      `Your handover code is ${out.handoverCode}. Give that to the traveler when you meet and you’ve checked the item.`,
    );
  } catch (e: any) {
    console.error(`[shopper-agent] settlement error: ${e.message}`);
    await reply(s, escrowErrorForUser(e));
  }
}

/** Handle one inbound user message; replies go via Linq or Relay. */
export async function handleInbound(args: {
  phone: string;
  chatId: string | null;
  text: string;
  imageUrls?: string[];
  /** True when user sent media we could not download. */
  mediaFailed?: boolean;
  channel?: "linq" | "relay";
  relayEventId?: string;
  relayMessageId?: string;
}): Promise<void> {
  const text = args.text.trim();
  const imageUrls = (args.imageUrls ?? []).filter(Boolean);
  if (!text && imageUrls.length === 0 && !args.mediaFailed) return;

  const s = getOrCreateSession(args.phone, args.chatId, {
    channel: args.channel ?? "linq",
    relayEventId: args.relayEventId,
    relayMessageId: args.relayMessageId,
  });

  if (s.chatId) {
    presenceRead(s);
    presenceTyping(s);
  }

  try {
    if (args.mediaFailed && imageUrls.length === 0) {
      await reply(
        s,
        text
          ? `I couldn’t open that photo — what product should I shop for?`
          : `I can tell you sent a photo, but I couldn’t open it. What product should I shop for?`,
        { thinkMs: 400 },
      );
      if (!text) return;
    }
    appendDialogTurn(s, "user", text || (imageUrls.length ? "[photo]" : ""));
    await handleInboundInner(s, args, text, imageUrls);
  } catch (e: any) {
    console.error(`[shopper-agent] handleInbound boom: ${e?.message ?? e}`);
    markSessionDirty();
    try {
      const prompt = s.pending?.prompt?.trim();
      await reply(
        s,
        prompt ||
          (s.ranked?.length && s.selected
            ? `Say yes to see the total and wait on ${s.ranked[0]!.name}.`
            : `Say yes to continue.`),
        { thinkMs: 400 },
      );
    } catch (sendErr: any) {
      console.error(`[shopper-agent] recovery reply failed: ${sendErr?.message ?? sendErr}`);
    }
  }
}

function applyCognitiveSlots(
  s: Session,
  slots: {
    product?: string | null;
    usCity?: string | null;
    deliveryCity?: string | null;
    ghCity?: string | null;
    deadline?: string | null;
    maxFeeUsd?: number | null;
    category?: string | null;
  },
) {
  if (slots.usCity) {
    const buyFrom = parseShoppingCity(slots.usCity);
    if (buyFrom) s.shoppingCity = buyFrom;
  }
  const dest = slots.deliveryCity ?? slots.ghCity;
  if (dest) s.deliveryCity = parseDeliveryTown(dest) ?? dest;
  if (slots.deadline) s.deadline = parseDate(slots.deadline) ?? undefined;
  if (typeof slots.maxFeeUsd === "number" && slots.maxFeeUsd > 0) {
    s.maxFeeCents = Math.round(slots.maxFeeUsd * 100);
  }
  if (slots.category) s.category = slots.category;
}

async function commitConfirmedProduct(
  s: Session,
  product: string,
  slots?: Parameters<typeof applyCognitiveSlots>[1],
): Promise<void> {
  const q = namedProduct(product);
  if (!q) {
    await sayHost(s, "REASK", parkItemAsk(s));
    return;
  }
  s.searchQuery = q;
  const cog = ensureCognition(s);
  cog.pending = null;
  cog.topic = "shopping";
  appendEpisode(cog.memory, "slot", `Product locked: ${q}`, { product: q });
  if (slots) applyCognitiveSlots(s, slots);
  markSessionDirty();
  rememberItem(stayOf(s), q);
  await runSearchFlow(s, `Searching “${q}”…`);
}

async function handleInboundInner(
  s: Session,
  args: {
    phone: string;
    chatId: string | null;
    text: string;
    imageUrls?: string[];
    channel?: "linq" | "relay";
    relayEventId?: string;
    relayMessageId?: string;
  },
  text: string,
  imageUrls: string[],
): Promise<void> {
  const hasImages = imageUrls.length > 0;

  // AgentCard virtual cards — separate brain (MCP tool loop). Never hijack the
  // pay-sheet step, where "card" talk belongs to the funding flow.
  if (
    text &&
    !hasImages &&
    wantsCardTools(text) &&
    !(s.step === "await_pay_confirm" && s.paySheetSent)
  ) {
    await handleCardTurn(s.phone, text, (t) => reply(s, t));
    return;
  }

  hydratePending(s);
  const turn = classifyTurn(s, { text, hasPhoto: hasImages });
  stayOf(s).lastAct = turn.act;
  if (s.searchQuery) rememberItem(stayOf(s), s.selected?.productTitle ?? s.searchQuery);
  console.log(
    `[shopper-agent] turn chat=${s.chatId ?? "none"} requested_slot=${s.pending?.slot ?? "-"} filled=${filledSlotKeys(s).join(",") || "-"} act=${turn.act}`,
  );
  if (s.step === "await_traveler_decision" || stayOf(s).lastOfferId) {
    void syncWaitingShoppers();
  }

  const intent = classifyIntent(text, {
    step: s.step,
    listingCount: s.listings?.length,
    travelerCount: s.ranked?.length,
    listingLabels: listingLabels(s),
    travelerLabels: travelerLabels(s),
  });

  const greetingOnly =
    !hasImages &&
    /^(hi|hello|hey|start|restart|menu)\b[,!.\s]*$/i.test(text);

  const closer = !hasImages && isAffirmationOrCloser(text);

  if (turn.act === "META") {
    await handleMetaTurn(s, turn);
    return;
  }
  if (turn.act === "REASK") {
    if (
      (turn.slot === "product" || s.step === "idle" || s.step === "done" || s.step === "await_product") &&
      !s.searchQuery &&
      !stayOf(s).lastItem
    ) {
      await sayHost(s, "REASK", parkItemAsk(s));
      return;
    }
    if (stayOf(s).lastItem || s.pending || (s.step !== "idle" && s.step !== "done" && s.step !== "await_product")) {
      await reaskOpen(s);
      return;
    }
    if (!s.pending && (s.step === "idle" || s.step === "done" || s.step === "await_product")) {
      await sayHost(s, "REASK", parkItemAsk(s));
      return;
    }
    await reaskOpen(s);
    return;
  }
  if (turn.act === "REPAIR") {
    const openPrompt = s.pending?.prompt;
    const openSlot = s.pending;
    applyRepairSlots(s, turn);
    if (openSlot) {
      s.pending = openSlot;
      if (openPrompt) s.pending.prompt = openPrompt;
      persistSessionsNow();
      await reaskOpen(s);
      return;
    }
    await continueAfterListing(s);
    return;
  }
  if (turn.act === "CONTINUE") {
    if (s.step === "await_traveler_decision") {
      await syncWaitingShoppers();
      if ((s.step as string) === "await_pay_confirm" && closer) {
        if (s.paySheetSent) {
          await reply(s, `Open the pay link I sent — I’ll lock it once your card is on file.`);
          return;
        }
        await fundAfterAccept(s);
        return;
      }
    }
    if (s.step === "await_extend") {
      const named =
        Boolean(s.extendCandidate?.name) &&
        s.extendCandidate!.name.split(/\s+/)[0]!.length >= 2 &&
        text.toLowerCase().includes(s.extendCandidate!.name.split(/\s+/)[0]!.toLowerCase());
      const rawNeedBy = typeof turn.value === "string" ? turn.value : turn.query;
      if (closer || turn.slot === "brief" || turn.slot === "need_by" || named) {
        const ok =
          turn.slot === "need_by" && rawNeedBy
            ? commitNeedBy(s, rawNeedBy)
            : await commitStretch(s);
        if (ok) {
          await continueAfterListing(s);
          return;
        }
      }
    }
    if (
      closer &&
      s.selected &&
      (s.ranked?.length ?? 0) > 0 &&
      ["await_product", "idle", "done", "await_brief_confirm"].includes(s.step)
    ) {
      if (s.chatId) presenceTyping(s);
      await presentQuoteAndWait(s);
      return;
    }
    if (await resolveOpenQuestion(s, text, intent)) return;
    if (await applyDialogAffirm(s, text, intent)) return;
    if (turn.slot === "listing" && turn.optionIndex != null) {
      await selectListing(s, turn.optionIndex);
      return;
    }
    if (turn.slot === "traveler" && turn.optionIndex != null) {
      await lockTraveler(s, turn.optionIndex);
      return;
    }
    if (turn.slot === "need_by") {
      const raw = typeof turn.value === "string" ? turn.value : turn.query;
      if (raw && commitNeedBy(s, raw)) {
        await continueAfterListing(s);
        return;
      }
    }
    if (turn.slot === "delivery_fee" && typeof turn.value === "number") {
      s.maxFeeCents = turn.value;
      clearPending(s);
      if (s.chatId) presenceTyping(s);
      await presentQuoteAndWait(s);
      return;
    }
    if (turn.slot === "shopping_city" && typeof turn.value === "string") {
      s.shoppingCity = turn.value;
      clearPending(s);
      await runSearchFlow(s);
      return;
    }
    if (turn.slot === "delivery_city" && typeof turn.value === "string") {
      commitDeliveryCity(s, turn.value);
      clearPending(s);
      await continueAfterListing(s);
      return;
    }
    if (turn.slot === "product" && typeof turn.value === "string") {
      clearPending(s);
      await applyNewQuery(s, turn.value);
      return;
    }
    await reaskOpen(s);
    return;
  }

  // NEW only — search / cognition-as-new-item lives below this line.
  await abandonOpenRequest(s);
  resetSession(s);
  s.step = "await_product";
  markSessionDirty();
  let inbound = text;
  if (greetingOnly || (!text && !hasImages)) {
    await sayHost(s, "NEW", shopperIntakeLine(s));
    return;
  }
  if (hasImages) {
    await reply(s, "Hey — got your photo. One sec…", { thinkMs: 350 });
  }
  if (turn.query && !hasImages) {
    inbound = turn.query;
  }

  const shouldCognize = hasImages || Boolean(s.cognition?.pending) || process.env.LINQ_COGNITION === "1";

  if (shouldCognize) {
    if ((hasImages || (s.step as Step) === "await_shopping_city") && s.chatId) presenceTyping(s);
    let decision;
    try {
      decision = await runPolicyTurn({ session: s, text: inbound, imageUrls });
    } catch (e: any) {
      console.warn(`[shopper-agent] cognition failed: ${e?.message ?? e}`);
      s.step = "await_product";
      persistSessionsNow();
      await reply(s, s.pending?.prompt || "What are you looking for? Text or a photo of the item works.");
      return;
    }
    if (decision.applySlots) applyCognitiveSlots(s, decision.applySlots);
    if (decision.bubbles.length) await say(s, ...decision.bubbles);
    if (decision.confirmedProduct) {
      await commitConfirmedProduct(s, decision.confirmedProduct, decision.applySlots);
      return;
    }
    if (decision.confirmedUsCity) {
      if (s.searchQuery) {
        s.shoppingCity = decision.confirmedUsCity;
        markSessionDirty();
        await runSearchFlow(s);
        return;
      }
      parkDestAsk(s);
      commitDeliveryCity(s, decision.confirmedUsCity);
      await sayHost(s, stayOf(s).lastAct ?? "CONTINUE", DEST_ASK);
      return;
    }
    if (!decision.fallthrough) {
      markSessionDirty();
      return;
    }
    if (hasImages && !decision.confirmedProduct && !s.searchQuery) {
      await reply(s, `I couldn’t tell what that is from the photo — type the item?`);
      return;
    }
  }

  if (
    intent.kind === "new_query" &&
    intent.query &&
    !isAffirmationOrCloser(intent.query) &&
    s.step !== "await_product" &&
    s.step !== "await_product_confirm" &&
    s.step !== "await_deadline" &&
    s.step !== "await_max_fee" &&
    s.step !== "await_delivery_city" &&
    s.step !== "await_extend" &&
    s.step !== "await_brief_confirm" &&
    s.step !== "await_pay_confirm" &&
    s.step !== "await_traveler_decision"
  ) {
    await applyNewQuery(s, intent.query);
    return;
  }

  switch (s.step as Step) {
    case "await_product_confirm": {
      // Policy should have handled yes/no; if we fell through, ask again
      const hyp = s.cognition?.pending?.hypothesis;
      const item = hyp ? parseItem(hyp) : null;
      await reply(
        s,
        item
          ? `Just to confirm — shop for ${item}? (yes / no)`
          : `What product should I shop for? Text or a photo works.`,
      );
      return;
    }
    case "await_product": {
      if (hasImages) {
        await reply(s, `I couldn’t tell what that is from the photo — type the item?`);
        return;
      }
      if (isAffirmationOrCloser(text)) {
        await sayHost(s, "REASK", parkItemAsk(s));
        return;
      }
      const inboundUrl = extractProductUrl(inbound) ?? extractProductUrl(text);
      if (inboundUrl) {
        await intakeProductUrl(s, inboundUrl);
        return;
      }
      let query = namedProduct(inbound);
      const llm = makeLlm();
      if (llm && process.env.LINQ_LLM_EXTRACT !== "0") {
        try {
          const o = await Promise.race([
            extractOrder(llm, inbound),
            new Promise<null>((_, rej) => setTimeout(() => rej(new Error("extract timeout")), 3_000)),
          ]);
          if (o && (o as any).itemName) {
            query = namedProduct(String((o as any).itemName)) ?? query;
          }
          if (o && (o as any).city) s.deliveryCity = parseDeliveryTown((o as any).city) ?? (o as any).city;
          if (o && (o as any).deadline) s.deadline = parseDate((o as any).deadline) ?? undefined;
          if (o && (o as any).maxFeeUsd) s.maxFeeCents = Math.round((o as any).maxFeeUsd * 100);
          if (o && (o as any).category) s.category = (o as any).category;
        } catch (e: any) {
          console.warn(`[shopper-agent] extractOrder skipped: ${e.message}`);
        }
      }
      if (!query) {
        await sayHost(s, "REASK", parkItemAsk(s));
        return;
      }
      s.searchQuery = query;
      ensureCognition(s).topic = "shopping";
      appendEpisode(ensureCognition(s).memory, "slot", `Product from text: ${query}`, { product: query });
      markSessionDirty();
      rememberItem(stayOf(s), query);
      await runSearchFlow(s, `Got it — searching ${query}…`);
      return;
    }
    case "await_shopping_city": {
      // Catalog is national. Leftover sessions on this step search and move on.
      if (s.searchQuery) {
        await runSearchFlow(s);
        return;
      }
      s.step = "await_product";
      markSessionDirty();
      await sayHost(s, "REASK", parkItemAsk(s));
      return;
    }
    case "await_listing": {
      if (intent.kind === "reject_results") {
        s.listings = undefined;
        s.step = "await_product";
        markSessionDirty();
        await say(s, `Got it — those weren’t right.`, `What should I look for instead?`);
        return;
      }
      if (intent.kind === "select" && intent.index != null) {
        await selectListing(s, intent.index);
        return;
      }
      if (intent.kind === "new_query" && intent.query) {
        await applyNewQuery(s, intent.query);
        return;
      }
      const list = s.listings ?? [];
      await reply(
        s,
        `Send 1–${list.length}, a store name (like Target), or tell me what’s wrong / what to search instead.`,
      );
      return;
    }
    case "await_delivery_city": {
      if (intent.kind === "reject_results") {
        s.step = "await_product";
        s.offer = undefined;
        markSessionDirty();
        await reply(s, `Okay — what product should I search for?`);
        return;
      }
      if (intent.kind === "no") {
        const rest = text.replace(/^(n|no|nope|nah)[,.\s]*/i, "").trim();
        if (rest) {
          commitDeliveryCity(s, rest);
          await continueAfterListing(s);
          return;
        }
        parkDestAsk(s);
        await reply(s, DEST_ASK);
        return;
      }
      commitDeliveryCity(s, text);
      await continueAfterListing(s);
      return;
    }
    case "await_deadline": {
      if (intent.kind === "no") {
        const rest = text.replace(/^(n|no|nope|nah)[,.\s]*/i, "").trim();
        const d = rest ? parseDate(rest) : null;
        if (d && commitNeedBy(s, d)) {
          await continueAfterListing(s);
          return;
        }
        s.offer = undefined;
        s.pending = {
          slot: "need_by",
          proposed: null,
          kind: "date",
          prompt: dateAskPrompt(s.deliveryCity ?? "your city", null),
        };
        rememberQuestion(stayOf(s), s.pending.prompt);
        persistBeforeAsk(persistSessionsNow);
        await sayHost(s, stayOf(s).lastAct ?? "CONTINUE", s.pending.prompt);
        return;
      }
      const d = parseDate(text);
      if (!d) {
        await reply(s, s.pending?.prompt || dateAskPrompt(s.deliveryCity ?? "your city", s.offer?.field === "deadline" ? s.offer.value : null));
        return;
      }
      if (!commitNeedBy(s, d)) {
        await askNeedBy(s);
        return;
      }
      await continueAfterListing(s);
      return;
    }
    case "await_max_fee": {
      if (/\b(cheap|cheaper|less|lower|reduce|too much)\b/i.test(text)) {
        const base = s.offer?.field === "maxFeeCents" ? parseInt(s.offer.value, 10) : 3000;
        const cheaper = Math.max(1000, Math.round((Number.isFinite(base) ? base : 3000) * 0.7));
        s.maxFeeCents = cheaper;
        s.offer = undefined;
        markSessionDirty();
        if (s.chatId) presenceTyping(s);
        await presentQuoteAndWait(s);
        return;
      }
      if (intent.kind === "no") {
        const rest = text.replace(/^(n|no|nope|nah)[,.\s]*/i, "").trim();
        const cents = rest ? parseUsdCents(rest) : null;
        if (cents != null) {
          s.maxFeeCents = cents;
          s.offer = undefined;
          markSessionDirty();
          if (s.chatId) presenceTyping(s);
          await presentQuoteAndWait(s);
          return;
        }
        s.offer = undefined;
        setOffer(s, "maxFeeCents", "2000");
        await reply(s, `What cap works — $20, or send a number?`);
        return;
      }
      const cents = parseUsdCents(text);
      if (cents == null) {
        await reply(s, `Just the dollar amount is fine — like 40. Or say yes to $30.`);
        return;
      }
      s.maxFeeCents = cents;
      s.offer = undefined;
      markSessionDirty();
      if (s.chatId) presenceTyping(s);
      await presentQuoteAndWait(s);
      return;
    }
    case "await_extend": {
      if (!isYes(text) && intent.kind !== "yes") {
        const named =
          Boolean(s.extendCandidate?.name) &&
          text.toLowerCase().includes((s.extendCandidate!.name.split(/\s+/)[0] ?? "").toLowerCase());
        if (!named) {
          s.step = "done";
          markSessionDirty();
          await reply(s, `Got it — I’ll leave it. Ping me with hi whenever you want to try again.`);
          return;
        }
      }
      if (!(await commitStretch(s))) {
        s.step = "done";
        markSessionDirty();
        await reply(s, `Nothing left to extend — say hi to start over.`);
        return;
      }
      await continueAfterListing(s);
      return;
    }
    case "await_traveler": {
      let idx: number | null = intent.kind === "select" && intent.index != null ? intent.index : null;
      if (idx == null) {
        const n = parseInt(text, 10) - 1;
        const ranked = s.ranked ?? [];
        if (n >= 0 && n < ranked.length) idx = n;
      }
      const ranked = s.ranked ?? [];
      if (idx == null || !(idx >= 0 && idx < ranked.length)) {
        await reply(s, `Pick a traveler — a name or number from 1 to ${ranked.length}.`);
        return;
      }
      await lockTraveler(s, idx);
      return;
    }
    case "await_brief_confirm": {
      if (intent.kind === "no" || /^(n|no|nope|nah|change)\b/i.test(text)) {
        s.step = "await_traveler";
        markSessionDirty();
        await reply(s, `What should we change — another traveler, or say hi to start over?`);
        return;
      }
      if (isYes(text) || intent.kind === "yes" || acceptsOffer(text, intent)) {
        await parkWaitingOnTraveler(s);
        return;
      }
      await reply(s, briefConfirmCopy(handoverCity(s)));
      return;
    }
    case "await_traveler_decision": {
      await syncWaitingShoppers();
      const afterWait = s.step as string;
      if (afterWait === "await_pay_confirm") {
        if (s.paySheetSent) {
          await reply(s, `Open the pay link I sent — I’ll lock it once your card is on file.`);
          return;
        }
        if (isYes(text) || intent.kind === "yes" || acceptsOffer(text, intent)) {
          await fundAfterAccept(s);
        }
        return;
      }
      if (s.offer?.field === "traveler" && (isYes(text) || intent.kind === "yes" || acceptsOffer(text, intent))) {
        const idx = parseInt(s.offer.value, 10);
        if (s.ranked?.[idx]) {
          await lockTraveler(s, idx);
          return;
        }
      }
      if (s.offer?.field === "traveler" && (intent.kind === "no" || /^(n|no|nope|nah)\b/i.test(text))) {
        s.step = "await_traveler";
        s.offer = undefined;
        markSessionDirty();
        await reply(s, `What should we change — another traveler, or a different date?`);
        return;
      }
      const carry = s.bidId ? await getOffer(s.bidId) : null;
      if (carry?.status === "accepted") {
        await reply(s, acceptedNoFundCopy(carry.travelerName));
        return;
      }
      await reply(s, waitingCopy(handoverCity(s)));
      return;
    }
    case "await_pay_confirm": {
      if (s.paySheetSent) {
        if (await maybeCompleteAgentCardFund(s)) return;
        await reply(s, `Open the pay link I sent — I’ll lock it once your card is on file.`);
        return;
      }
      if (!demoLocalChain()) {
        console.warn("[shopper-agent] payment stub: no local escrow on this host (Relay logs only)");
        await reply(s, acceptedNoFundCopy(travelerDisplayName(s)));
        return;
      }
      if (!isYes(text) && intent.kind !== "yes" && !acceptsOffer(text, intent)) {
        await reply(
          s,
          `No charge. Say yes when you’re ready to lock ${formatUsd(s.totalCents ?? 0)} test USDC.`,
        );
        return;
      }
      await fundAfterAccept(s);
      return;
    }
    case "await_handover_done": {
      if (!/^(done|delivered|complete|yes)\b/i.test(text.trim())) {
        await reply(s, `Whenever you’ve got the item, text done. Your code is still ${s.handoverCode}.`);
        return;
      }
      try {
        if (s.chatId) presenceTyping(s);
        await reply(s, `Releasing escrow…`, { thinkMs: 500 });
        const out = demoLocalChain()
          ? await withTimeout(
              (async () => {
                const settled = await settleLocalEscrow({
                  escrowId: s.escrowId as `0x${string}`,
                  action: "release",
                });
                if (s.bidId) await updateOffer(s.bidId, { status: "released" });
                return { released: Boolean(settled.txHash), settleTxHash: settled.txHash };
              })(),
              ESCROW_TIMEOUT_MS,
              "escrow release",
            )
          : await withTimeout(
              completeHandoverAndRelease({
                bidId: s.bidId!,
                travelerId: s.chosenTravelerId!,
                code: s.handoverCode!,
              }),
              ESCROW_TIMEOUT_MS,
              "escrow release",
            );
        s.step = "done";
        markSessionDirty();
        await reply(
          s,
          out.released
            ? `All set — escrow released. Traveler’s paid (test USDC).\n\nGood chatting — say hi anytime for another run.`
            : `Got the handover. Settlement’s finishing up. Say hi if you need anything else.`,
        );
      } catch (e: any) {
        console.error(`[shopper-agent] handover error: ${e.message}`);
        await reply(s, `Handover didn’t stick — try done again, or say hi to restart.`);
      }
      return;
    }
    default:
      s.step = "await_product";
      markSessionDirty();
      await reply(s, `What are you looking for?`);
  }
}
