import { formatUsd, endOfLocalDay, computeFees, suggestedTravelerFeeCents } from "@manebra/shared";
import { normalizeCity, sameDestinationCity } from "@manebra/calendar";
import { searchProducts, hasSerpApiKey } from "@manebra/catalog";
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
  type ClassifiedTurn,
} from "@manebra/dialog";
import * as linq from "./linq-client.mts";
import * as relay from "./relay-client.mts";
import { SEED_TRAVELERS } from "./traveler-seeds.mts";
import {
  completeHandoverAndRelease,
} from "./settlement-bridge.mts";
import { demoLocalChain, fundLocalEscrow, settleLocalEscrow } from "../../agent-cli/src/local-escrow.mts";
import {
  writeOffer,
  updateOffer,
  getOffer,
  listLiveTrips,
} from "@manebra/db";
import { runPolicyTurn } from "./cognition/policy.mts";
import { appendEpisode, ensureCognition } from "./cognition/state.mts";
import { parseUsShoppingCity, isCityAdviceQuestion, recommendUsCityBubble } from "./cognition/cities.mts";
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

function seedTravelers(): TravelerSeed[] {
  const now = new Date();
  const day = (n: number) => new Date(now.getTime() + n * 86400_000);
  return SEED_TRAVELERS.map((t) => ({
    id: t.id,
    name: t.name,
    trustScore: t.trustScore,
    avgRating: t.avgRating,
    totalDeliveries: t.totalDeliveries,
    minFeeCents: t.minFeeCents,
    trip: {
      id: `trip-${t.id}`,
      travelerId: t.id,
      direction: "us_to_gh" as const,
      destinationCity: "Accra",
      departureDate: day(t.daysUntilDep),
      status: "upcoming" as const,
    },
    profile: {
      id: t.id,
      isVerified: true,
      accountStatus: "active" as const,
      trustScore: t.trustScore,
      avgRating: t.avgRating,
      totalDeliveries: t.totalDeliveries,
    },
  }));
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

function shopperIntakeLine(s: Session): string {
  return s.channel === "relay"
    ? "What should I shop for you?"
    : "Send a product (text or photo) and I’ll find US stock and a traveler to Accra.";
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
  return (s.ranked ?? []).map((r) => ({
    label: r.name,
    haystack: `${r.name} ${r.departs}`,
  }));
}

function upcomingOnOrAfter(d: Date, now: Date): boolean {
  return d.getTime() > now.getTime();
}

function eligibleLiveTrip(t: { destinationCity: string; departureDate: Date; optedIn?: boolean; status?: string }, city: string, now: Date): boolean {
  if (t.optedIn === false) return false;
  if (t.status && t.status !== "upcoming") return false;
  if (!upcomingOnOrAfter(t.departureDate, now)) return false;
  return sameDestinationCity(t.destinationCity, city);
}

async function loadLiveTravelers(city: string, deadline: Date): Promise<TravelerSeed[] | null> {
  const now = new Date();
  const dest = normalizeCity(city) ?? city;
  try {
    const mkt = (await listLiveTrips(dest)).filter((t) => eligibleLiveTrip(t, dest, now));
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
  if (!process.env.DATABASE_URL?.trim()) return null;
  try {
    const { prisma } = await import("@manebra/db");
    const trips = await prisma.travelerTrip.findMany({
      where: {
        status: "upcoming",
        direction: "us_to_gh",
        destinationCity: dest,
        departureDate: { gt: now },
      },
      include: { traveler: true },
      take: 20,
      orderBy: { departureDate: "asc" },
    });
    const live = trips.filter((t) => eligibleLiveTrip(t, dest, now));
    if (!live.length) return null;
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
    return null;
  }
}

async function runMatching(s: Session): Promise<string> {
  const selected = s.selected!;
  const city = s.deliveryCity!;
  const deadline = endOfLocalDay(s.deadline!);
  const category = s.category ?? categoryOf(selected.productTitle) ?? "electronics";
  const dest = normalizeCity(city) ?? city;
  const live = await loadLiveTravelers(city, deadline);
  const now = new Date();
  const pool = live ?? seedTravelers();
  const travelers = pool.filter((t) => eligibleLiveTrip(t.trip, dest, now));
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
      departs: next.t.trip.departureDate.toDateString(),
    };
    s.step = "await_extend";
    markSessionDirty();
    return (
      `Hmm — nobody’s flying before ${deadline.toDateString()}.\n` +
      `${next.t.name} leaves ${next.t.trip.departureDate.toDateString()} though.\n` +
      `Want me to stretch your deadline to meet them? Just say yes or no.`
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
      departs: t.trip.departureDate.toDateString(),
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
    s.pending = {
      slot: "brief",
      proposed: "yes",
      kind: "bool",
      prompt: matchText,
    };
    rememberQuestion(stayOf(s), matchText);
    persistSessionsNow();
    await reply(s, matchText, { thinkMs: 1400 });
    return;
  }
  const quote = quoteLines(s);
  rememberItem(stayOf(s), s.selected?.productTitle ?? s.searchQuery ?? "");
  if (s.totalCents) rememberQuote(stayOf(s), s.totalCents);
  if (s.ranked?.length) {
    await say(s, quote);
    await lockTraveler(s, 0, { quoteAlreadyShown: true });
    return;
  }
  s.step = "await_traveler_decision";
  s.chosenTravelerId = undefined;
  clearPending(s);
  await say(
    s,
    quote,
    `No one's heading to ${s.deliveryCity ?? "your city"} yet. I’ll notify you when a traveler is on that route and agrees after they book.`,
  );
}

async function continueAfterListing(s: Session): Promise<void> {
  if (!s.deliveryCity) {
    s.step = "await_delivery_city";
    setOffer(s, "deliveryCity", "Accra", "Where in Ghana should it land? Accra, Kumasi…");
    markSessionDirty();
    await say(
      s,
      `Nice — ${s.selected!.storeName}, ${formatUsd(s.selected!.priceCents)}.`,
      `Where in Ghana should it land? Accra, Kumasi…`,
    );
    return;
  }
  if (!s.deadline) {
    s.step = "await_deadline";
    setOffer(s, "deadline", "15th August", "Need it by 15th August? Say yes, or send another date.");
    markSessionDirty();
    await sayHost(s, stayOf(s).lastAct ?? "CONTINUE", `Need it by 15th August? Say yes, or send another date.`);
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
      searchProducts({ query: q, shoppingCity: s.shoppingCity }),
      SERP_TIMEOUT_MS,
      "SerpAPI search",
    );
    s.listings = results.listings.slice(0, 5);
  } catch (e: any) {
    console.warn(`[shopper-agent] search failed: ${e?.message ?? e}`);
    s.step = "await_product";
    markSessionDirty();
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
  const lines = s.listings.map(
    (l, i) => `${i + 1}. ${l.storeName} · ${formatUsd(l.priceCents)}\n   ${l.productTitle.slice(0, 70)}`,
  );
  return (
    `Found a few near ${s.shoppingCity}:\n\n${lines.join("\n\n")}\n\n` +
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
    await reply(s, `One sec — checking verified stores near ${s.shoppingCity}…`, { thinkMs: 700 });
  }
  if (s.chatId) presenceTyping(s);
  await reply(s, await searchAndPromptListings(s), { thinkMs: 1200 });
}

async function applyNewQuery(s: Session, query: string): Promise<void> {
  s.searchQuery = normalizeSearchQuery(query);
  s.selected = undefined;
  s.listings = undefined;
  markSessionDirty();
  if (!s.shoppingCity) {
    s.step = "await_shopping_city";
    markSessionDirty();
    setOffer(s, "shoppingCity", "New York");
    await say(s, `Got it — “${s.searchQuery}”.`, `Which US city should I shop in? New York is usually solid.`);
    return;
  }
  await runSearchFlow(s, `Got it — searching ${s.searchQuery} near ${s.shoppingCity}…`);
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
    setOffer(s, "deadline", "15th August", "Need it by 15th August? Say yes, or send another date.");
  } else if (s.step === "await_max_fee") {
    setOffer(
      s,
      "maxFeeCents",
      String(s.maxFeeCents ?? 3000),
      "What’s the most you’d pay the traveler in USD? $30 is a common cap — say that’s fine, or send a number.",
    );
  } else if (s.step === "await_delivery_city") {
    setOffer(s, "deliveryCity", s.deliveryCity ?? "Accra", "Where in Ghana should it land? Accra, Kumasi…");
  } else if (s.step === "await_shopping_city") {
    setOffer(s, "shoppingCity", "New York", "Which US city should I shop in? New York is usually solid.");
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
      ? "Need it by 15th August? Say yes, or send another date."
      : s.step === "await_max_fee"
        ? "Send a dollar amount, or say that’s fine for $30."
        : s.step === "await_delivery_city"
          ? "Where in Ghana should it land? Accra, Kumasi…"
          : s.step === "await_shopping_city"
            ? "Which US city should I shop in? New York is usually solid."
            : s.step === "await_listing"
              ? `Pick one (1–${s.listings?.length ?? 1} or a store name), or tell me if these aren’t right.`
              : s.step === "await_traveler"
                ? `Pick a traveler — a name or number from 1 to ${s.ranked?.length ?? 1}.`
                : s.step === "await_traveler_decision"
                  ? `Still waiting on ${s.ranked?.find((t) => t.id === s.chosenTravelerId)?.name ?? "the traveler"}. I’ll ping you when they agree.`
                  : s.step === "await_pay_confirm"
                    ? `Say yes when you’re ready to lock ${formatUsd(s.totalCents ?? 0)} test USDC.`
                    : "Still on that last question — say yes to the suggestion, or send the value.")
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
    resetSession(s);
    s.step = "await_product";
    persistSessionsNow();
    await sayHost(s, "META", shopperIntakeLine(s), "cancel");
    return;
  }
  if (s.step === "await_traveler_decision") {
    void syncWaitingShoppers();
    const waiting = s.ranked?.find((t) => t.id === s.chosenTravelerId)?.name ?? stayOf(s).lastTravelerName;
    rememberCounterparty(stayOf(s), waiting);
    rememberWait(stayOf(s));
    await sayHost(s, "META", `I’ll ping you when they agree.`, turn.meta);
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
    await reply(s, prompt || "Still on that last question — say yes to the suggestion, or send the value.");
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
    await reply(s, s.pending?.prompt || "Need it by 15th August? Say yes, or send another date.");
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
    await fundAfterAccept(s);
    return true;
  }
  if (!acceptsOffer(text, intent) || !s.offer) return false;
  const { field } = s.offer;
  const matches =
    (field === "shoppingCity" && s.step === "await_shopping_city") ||
    (field === "deliveryCity" && s.step === "await_delivery_city") ||
    (field === "deadline" && s.step === "await_deadline") ||
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
    s.deliveryCity = value;
    markSessionDirty();
    await continueAfterListing(s);
    return true;
  }
  if (field === "deadline") {
    const d = parseDate(value);
    if (!d) return false;
    s.deadline = d;
    markSessionDirty();
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

async function lockTraveler(s: Session, idx: number, opts?: { quoteAlreadyShown?: boolean }): Promise<void> {
  const ranked = s.ranked ?? [];
  const chosen = ranked[idx]!;
  s.chosenTravelerId = chosen.id;
  const item = s.selected!;
  const fee = suggestedTravelerFeeCents(item.priceCents);
  const capped = Math.min(fee, s.maxFeeCents ?? fee);
  const fees = computeFees(item.priceCents, capped);
  s.totalCents = fees.totalCents;
  markSessionDirty();
  if (!opts?.quoteAlreadyShown) {
    await say(
      s,
      `${item.productTitle.slice(0, 80)}\n` +
        `Item ${formatUsd(item.priceCents)} + traveler ${formatUsd(capped)} → ${formatUsd(fees.totalCents)} all-in`,
    );
  }
  await parkWaitingOnTraveler(s);
}

function travelerDisplayName(s: Session, fallback = "The traveler"): string {
  return (s.ranked ?? []).find((t) => t.id === s.chosenTravelerId)?.name ?? fallback;
}

function acceptedNoFundCopy(travelerName: string): string {
  return `${travelerName} accepted. Funding isn’t available on this host yet — I’ll keep the order as accepted.`;
}

function nextRanked(s: Session): { id: string; name: string; departs: string } | null {
  const ranked = s.ranked ?? [];
  const i = ranked.findIndex((t) => t.id === s.chosenTravelerId);
  return ranked[i + 1] ?? ranked.find((t) => t.id !== s.chosenTravelerId) ?? null;
}

async function parkWaitingOnTraveler(s: Session): Promise<void> {
  const chosen = (s.ranked ?? []).find((t) => t.id === s.chosenTravelerId);
  const item = s.selected!;
  const next = nextRanked(s);
  const id = s.bidId ?? `req-${sessionKey(s.phone)}-${Date.now()}`;
  s.bidId = id;
  s.step = "await_traveler_decision";
  rememberItem(stayOf(s), item.productTitle);
  if (s.totalCents) rememberQuote(stayOf(s), s.totalCents);
  rememberCounterparty(stayOf(s), chosen?.name, s.chosenTravelerId);
  rememberOffer(stayOf(s), id);
  rememberWait(stayOf(s));
  rememberQuestion(stayOf(s), `I’ll send this to ${chosen?.name ?? "a traveler"} heading your way. I’ll ping you when they agree.`);
  clearPending(s);
  try {
    const fee = suggestedTravelerFeeCents(item.priceCents);
    const capped = Math.min(fee, s.maxFeeCents ?? fee);
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
  await say(
    s,
    `I’ll send this to ${chosen?.name ?? "a traveler"} heading your way. I’ll ping you when they agree.`,
  );
}

/** When Traveler accepts/declines, ping waiting Shopper (same process as Relay long-poll). */
export async function syncWaitingShoppers(): Promise<void> {
  for (const s of allSessions()) {
    if (s.step !== "await_traveler_decision" || !s.bidId) continue;
    const carry = await getOffer(s.bidId);
    if (!carry || carry.notifiedShopper) continue;
    if (carry.status === "accepted") {
      await updateOffer(carry.id, { notifiedShopper: true });
      await say(s, `${carry.travelerName} agreed.`);
      if (demoLocalChain()) {
        s.step = "await_pay_confirm";
        setOffer(
          s,
          "pay",
          "yes",
          `Lock ${formatUsd(carry.totalCents)} test USDC in escrow for this request?`,
        );
        await say(s, `Fund ${formatUsd(carry.totalCents)} USDC to lock it.`);
      } else {
        console.warn("[shopper-agent] payment stub: no local escrow on this host (Relay logs only)");
        clearPending(s);
        await say(s, acceptedNoFundCopy(carry.travelerName));
      }
    } else if (carry.status === "declined") {
      await updateOffer(carry.id, { notifiedShopper: true });
      const next = nextRanked(s);
      if (next) {
        setOffer(
          s,
          "traveler",
          String((s.ranked ?? []).findIndex((t) => t.id === next.id)),
          `They couldn’t take it. Want me to try ${next.name}?`,
        );
        await say(s, `They couldn’t take it. Want me to try ${next.name}?`);
      } else {
        s.step = "await_traveler";
        markSessionDirty();
        await reply(s, `They couldn’t take it. Want a different traveler, or change the request?`);
      }
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
          ? `I couldn’t open that photo — what product should I shop for? (got your note: “${text.slice(0, 80)}”)`
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
            ? `Still on that order — say yes to see the total and wait on ${s.ranked[0]!.name}.`
            : `Still on that last step — say yes to continue.`),
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
    ghCity?: string | null;
    deadline?: string | null;
    maxFeeUsd?: number | null;
    category?: string | null;
  },
) {
  if (slots.usCity) {
    const us = parseUsShoppingCity(slots.usCity);
    if (us) s.shoppingCity = us;
  }
  if (slots.ghCity) s.deliveryCity = normalizeCity(slots.ghCity) ?? slots.ghCity;
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
  const q = normalizeSearchQuery(product);
  s.searchQuery = q;
  const cog = ensureCognition(s);
  cog.pending = null;
  cog.topic = "shopping";
  appendEpisode(cog.memory, "slot", `Product locked: ${q}`, { product: q });
  if (slots) applyCognitiveSlots(s, slots);
  markSessionDirty();

  // If US city was filled (and not just the default placeholder path), search;
  // otherwise ask for shopping city — New York stays the suggested default.
  const cityFromSlots = Boolean(slots?.usCity?.trim());
  if (cityFromSlots) {
    await runSearchFlow(s, `Searching “${q}” near ${s.shoppingCity}…`);
    return;
  }
  s.step = "await_shopping_city";
  markSessionDirty();
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
    if (stayOf(s).lastItem || s.pending || (s.step !== "idle" && s.step !== "done" && s.step !== "await_product")) {
      await reaskOpen(s);
      return;
    }
    if (!s.pending && (s.step === "idle" || s.step === "done" || s.step === "await_product")) {
      s.step = "await_product";
      persistSessionsNow();
      await sayHost(s, "REASK", shopperIntakeLine(s));
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
        await fundAfterAccept(s);
        return;
      }
    }
    if (
      closer &&
      s.selected &&
      (s.ranked?.length ?? 0) > 0 &&
      ["await_extend", "await_product", "idle", "done", "await_brief_confirm"].includes(s.step)
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
    if (turn.slot === "need_by" && typeof turn.value === "string") {
      const d = parseDate(turn.value) ?? new Date(turn.value);
      if (!Number.isNaN(d.getTime())) {
        s.deadline = d;
        clearPending(s);
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
      s.deliveryCity = turn.value;
      clearPending(s);
      await continueAfterListing(s);
      return;
    }
    await reaskOpen(s);
    return;
  }

  // NEW only — search / cognition-as-new-item lives below this line.
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
      if (decision.confirmedUsCity) {
        s.shoppingCity = decision.confirmedUsCity;
        markSessionDirty();
        await runSearchFlow(s);
        return;
      }
      if ((s.step as Step) === "await_shopping_city" && !decision.bubbles.some((b) => /city|york|atlanta/i.test(b))) {
        setOffer(s, "shoppingCity", "New York");
        await reply(s, `Which US city should I shop in for ${s.searchQuery}? New York is usually strongest.`);
      }
      markSessionDirty();
      return;
    }
    if (decision.confirmedUsCity) {
      s.shoppingCity = decision.confirmedUsCity;
      markSessionDirty();
      await runSearchFlow(s);
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
      await reply(
        s,
        hyp
          ? `Just to confirm — shop for ${hyp}? (yes / no)`
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
        await reply(s, s.pending?.prompt || "What are you looking for? Text or a photo of the item works.");
        return;
      }
      let query = normalizeSearchQuery(inbound);
      if (!query || /^(photo|image|\[attachment\])$/i.test(query)) {
        await reply(s, `What are you looking for? Text or a photo of the item works.`);
        return;
      }
      const llm = makeLlm();
      if (llm && process.env.LINQ_LLM_EXTRACT !== "0") {
        try {
          const o = await Promise.race([
            extractOrder(llm, inbound),
            new Promise<null>((_, rej) => setTimeout(() => rej(new Error("extract timeout")), 3_000)),
          ]);
          if (o && (o as any).itemName) query = normalizeSearchQuery((o as any).itemName);
          if (o && (o as any).city) s.deliveryCity = normalizeCity((o as any).city) ?? (o as any).city;
          if (o && (o as any).deadline) s.deadline = parseDate((o as any).deadline) ?? undefined;
          if (o && (o as any).maxFeeUsd) s.maxFeeCents = Math.round((o as any).maxFeeUsd * 100);
          if (o && (o as any).category) s.category = (o as any).category;
        } catch (e: any) {
          console.warn(`[shopper-agent] extractOrder skipped: ${e.message}`);
        }
      }
      s.searchQuery = query;
      s.step = "await_shopping_city";
      setOffer(s, "shoppingCity", "New York");
      ensureCognition(s).topic = "shopping";
      appendEpisode(ensureCognition(s).memory, "slot", `Product from text: ${query}`, { product: query });
      markSessionDirty();
      rememberItem(stayOf(s), query);
      await sayHost(s, "NEW", `Which US city should I shop in for ${query}? New York is usually solid.`);
      return;
    }
    case "await_shopping_city": {
      if (intent.kind === "reject_results") {
        s.step = "await_product";
        markSessionDirty();
        await reply(s, `No problem — what should I look for instead?`);
        return;
      }
      if (/^(thanks|thank you|cool|great)\.?$/i.test(text)) {
        setOffer(s, "shoppingCity", s.offer?.field === "shoppingCity" ? s.offer.value : "New York");
        await reply(s, `Still on this — which US city should I search near? New York is usually strongest.`);
        return;
      }
      if (isCityAdviceQuestion(text)) {
        await say(s, ...recommendUsCityBubble(s.searchQuery));
        return;
      }
      const city = parseUsShoppingCity(text);
      if (!city) {
        await reply(
          s,
          `I need a real US shopping city — try New York, Atlanta, Houston, or LA.`,
        );
        return;
      }
      s.shoppingCity = city;
      markSessionDirty();
      await runSearchFlow(s);
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
          s.deliveryCity = normalizeCity(rest) ?? rest;
          s.offer = undefined;
          markSessionDirty();
          await continueAfterListing(s);
          return;
        }
        s.offer = undefined;
        markSessionDirty();
        await reply(s, `Which city in Ghana — Accra, Kumasi, or another?`);
        return;
      }
      s.deliveryCity = normalizeCity(text) ?? text;
      s.offer = undefined;
      markSessionDirty();
      await continueAfterListing(s);
      return;
    }
    case "await_deadline": {
      if (intent.kind === "no") {
        const rest = text.replace(/^(n|no|nope|nah)[,.\s]*/i, "").trim();
        const d = rest ? parseDate(rest) : null;
        if (d) {
          s.deadline = d;
          s.offer = undefined;
          markSessionDirty();
          await continueAfterListing(s);
          return;
        }
        s.offer = undefined;
        setOffer(s, "deadline", "15th August");
        await reply(s, `No problem — what date works? “20th” or “15th August” is fine.`);
        return;
      }
      const d = parseDate(text);
      if (!d) {
        await reply(s, `I didn’t catch that date — try something like “15th August”, or say yes to use that.`);
        return;
      }
      s.deadline = d;
      s.offer = undefined;
      markSessionDirty();
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
        s.step = "done";
        markSessionDirty();
        await reply(s, `Got it — I’ll leave it. Ping me with hi whenever you want to try again.`);
        return;
      }
      const travelers = seedTravelers();
      const alt = s.extendCandidate;
      if (!alt) {
        s.step = "done";
        markSessionDirty();
        await reply(s, `Nothing left to extend — say hi to start over.`);
        return;
      }
      const t = travelers.find((x) => x.id === alt.id);
      if (t) s.deadline = endOfLocalDay(t.trip.departureDate);
      markSessionDirty();
      await reply(s, `Cool — deadline moved to ${s.deadline!.toDateString()}. Matching now…`, {
        thinkMs: 900,
      });
      if (s.chatId) presenceTyping(s);
      await presentQuoteAndWait(s);
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
      await reply(s, `I’ll send this to the traveler heading your way — say yes to confirm.`);
      return;
    }
    case "await_traveler_decision": {
      await syncWaitingShoppers();
      const afterWait = s.step as string;
      if (afterWait === "await_pay_confirm") {
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
      const waitingName = s.ranked?.find((t) => t.id === s.chosenTravelerId)?.name ?? "the traveler";
      if (s.offer?.field === "traveler") {
        const next = nextRanked(s);
        await reply(s, next ? `They couldn’t take it. Want me to try ${next.name}?` : `They couldn’t take it. Want a different traveler?`);
        return;
      }
      await reply(s, `Still waiting on ${waitingName}. I’ll ping you when they agree.`);
      return;
    }
    case "await_pay_confirm": {
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
