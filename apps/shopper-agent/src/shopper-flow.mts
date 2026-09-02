import { formatUsd, endOfLocalDay, generateHandoverCode } from "@manebra/shared";
import { normalizeCity } from "@manebra/calendar";
import { resolveMetro, sameMetro, hubCity } from "@manebra/geo";
import { searchProducts, hasSerpApiKey, NoShopMarketError, shopMarketForCity, productNameFromUrl, listingsForPicker, resolveListingPick, type ProductListing } from "@manebra/catalog";

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
  rememberOffer,
  rememberWait,
  rememberCounterparty,
  parseItem,
  parseMerchant,
  parseCartQty,
  EARNINGS_ASK,
  SKU_FOUND,
  SKU_TOO_FEW,
  recapTotalCents,
  lineTaxCents,
  recapHash,
  listingCaption,
  listingHasPhoto,
  listingImageParts,
  guessImageContentType,
  recapBody,
  RECAP_PAY_ASK,
  PAYMENT_UNCONFIGURED,
  PAYMENT_RETRY,
  requestStatusLine,
  shopperWait,
  shopperNobody,
  shopperAccepted,
  parseShopPlace,
  extractProductUrl,
  parseMerchantName,

  type ClassifiedTurn,
} from "@manebra/dialog";
import * as linq from "./linq-client.mts";
import * as relay from "./relay-client.mts";
import { extractHttpUrl, listingFromProductUrl } from "./product-url.mts";
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
  canConfirmHeadingYourWay,
  nextUntriedIndex,
  noMatchCopy,
  offerTimedOut,
  requestExpiredCopy,
  requestPastDeadline,
  shopperStillWaiting,
} from "./match-policy.mts";
import { agentcardConfigured, createWalletLink, dropConnection, isAgentCardLoginError, PaySheet, nextShopperFundingStep } from "@repo/agentcard";
import { handleCardTurn, wantsCardTools } from "./agentcard-cards.mts";
import { runPolicyTurn } from "./cognition/policy.mts";
import { appendEpisode, ensureCognition } from "./cognition/state.mts";
import { parseDeliveryTown } from "./cognition/cities.mts";

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

const SERP_TIMEOUT_MS = 120_000;
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

async function replyParts(
  s: Session,
  parts: Array<Record<string, unknown>>,
  opts?: { thinkMs?: number },
): Promise<void> {
  const caption = parts
    .filter((p) => p.type === "text")
    .map((p) => String(p.text ?? ""))
    .join("\n")
    .trim();
  const hasMedia = parts.some((p) => p.type === "media");
  if (!caption && !hasMedia) {
    console.warn("[shopper-agent] skip empty parts reply");
    return;
  }
  if (caption) appendDialogTurn(s, "assistant", caption);
  if (s.channel === "relay") {
    if (s.chatId) {
      if (s.relayMessageId) void relay.markRead(s.chatId, s.relayMessageId);
      void relay.startTyping(s.chatId);
    }
    const paced = opts?.thinkMs ?? 700;
    await sleep(paced);
    if (!s.chatId) throw new Error("relay reply missing conversation id");
    s.relayReplySeq = (s.relayReplySeq ?? 0) + 1;
    const replyTo = s.relayReplySeq === 1 ? s.relayMessageId : null;
    const keySeed = caption || String(parts.find((p) => p.type === "media")?.url ?? "media");
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await relay.sendParts({
          conversationId: s.chatId,
          parts,
          idempotencyKey: relayIdempotencyKey(s, keySeed, attempt),
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
    console.log(`[shopper-agent] → relay media ${s.phone}: ${caption.slice(0, 80)}`);
    return;
  }
  console.warn("[shopper-agent] Linq cannot send Relay media parts — caption only (see PR)");
  await reply(s, caption || "Photo", opts);
}

async function sniffImageContentType(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    const ct = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (ct?.startsWith("image/")) return ct;
  } catch {
    /* HEAD often blocked on CDNs */
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-64" },
      redirect: "follow",
    });
    const ct = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (ct?.startsWith("image/")) return ct;
  } catch {
    return null;
  }
  return null;
}

async function replyListing(
  s: Session,
  listing: NonNullable<Session["selected"]>,
  n?: number,
): Promise<boolean> {
  const caption = listingCaption({
    title: listing.productTitle,
    merchant: listing.storeName,
    priceCents: listing.priceCents,
    n,
  });
  if (listingHasPhoto(listing.imageUrl)) {
    const sniffed = await sniffImageContentType(listing.imageUrl);
    const guessed = guessImageContentType(listing.imageUrl);
    const contentType = sniffed ?? guessed;
    // #region agent log
    fetch("http://127.0.0.1:7792/ingest/af7dba43-916f-44eb-8996-041bf3055f0c", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ee46bb" },
      body: JSON.stringify({
        sessionId: "ee46bb",
        runId: "post-fix",
        hypothesisId: "F",
        location: "apps/shopper-agent/src/shopper-flow.mts:replyListing",
        message: "listing image mime",
        data: {
          host: (() => {
            try {
              return new URL(listing.imageUrl).hostname;
            } catch {
              return "bad";
            }
          })(),
          sniffed,
          guessed,
          contentType,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    console.warn("[shopper-debug]", JSON.stringify({ imageHost: listing.storeName, sniffed, guessed, contentType }));
    // #endregion
    const parts = listingImageParts({
      title: listing.productTitle,
      merchant: listing.storeName,
      priceCents: listing.priceCents,
      imageUrl: listing.imageUrl,
      contentType,
      n,
    });
    if (parts.some((p) => p.type === "media")) {
      try {
        await replyParts(s, parts, { thinkMs: 500 });
        return true;
      } catch (e: any) {
        console.warn(`[shopper-agent] listing image send failed: ${e?.message ?? e}`);
      }
    }
  }
  try {
    await reply(s, caption, { thinkMs: 400 });
    return true;
  } catch (e: any) {
    console.warn(`[shopper-agent] listing text send failed: ${e?.message ?? e}`);
    return false;
  }
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

function commitShopPlace(s: Session, raw: string): boolean {
  const place = parseShopPlace(raw);
  if (!place || !shopMarketForCity(place)) return false;
  s.shoppingCity = place;
  s.offer = undefined;
  markSessionDirty();
  return true;
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
    return (s.listings ?? []).map((l, i) => ({
      id: String(i),
      label: listingCaption({
        title: l.productTitle,
        merchant: l.storeName,
        priceCents: l.priceCents,
        n: i + 1,
      }),
    }));
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
    label: listingCaption({ title: l.productTitle, merchant: l.storeName, priceCents: l.priceCents }),
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
  void origin;
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
  const travelers = (live ?? []).filter((t) => eligibleLiveTrip(t.trip, dest, now) && !tried.has(t.id));
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

function persistRecapTotal(s: Session): {
  title: string;
  merchant: string;
  itemCents: number;
  taxCents: number;
  earningsCents: number;
  totalCents: number;
  qty: number;
  sku: string;
  taxEstimated: boolean;
} {
  const item = s.selected!;
  const qty = Math.max(1, s.cart?.qty ?? 1);
  const itemCents = item.priceCents * qty;
  const tax = lineTaxCents(item, qty);
  const taxEstimated = !item.includesTax && (item.taxCents == null || item.taxCents < 0);
  const earningsCents = s.maxFeeCents ?? 0;
  const totalCents = recapTotalCents(itemCents, tax, earningsCents);
  s.totalCents = totalCents;
  if (!s.cart) s.cart = { listingId: item.listingId, qty };
  markSessionDirty();
  return {
    title: item.productTitle.slice(0, 80),
    merchant: item.storeName,
    itemCents,
    taxCents: tax,
    earningsCents,
    totalCents,
    qty,
    sku: s.cart.listingId,
    taxEstimated,
  };
}

function shownRecapHash(s: Session): string {
  const a = persistRecapTotal(s);
  return recapHash({
    sku: a.sku,
    qty: a.qty,
    itemCents: a.itemCents,
    taxCents: a.taxCents,
    earningsCents: a.earningsCents,
    totalCents: a.totalCents,
    handoverCity: handoverCity(s),
  });
}

function quoteLines(s: Session): string {
  const a = persistRecapTotal(s);
  return recapBody(a);
}

function parkEarningsAsk(s: Session): string {
  const prompt = EARNINGS_ASK;
  s.step = "await_max_fee";
  s.offer = undefined;
  s.pending = { slot: "delivery_fee", proposed: null, kind: "money", prompt };
  rememberQuestion(stayOf(s), prompt);
  persistBeforeAsk(persistSessionsNow);
  markSessionDirty();
  return prompt;
}

function parkRecapWait(s: Session): void {
  const hash = shownRecapHash(s);
  s.recapHash = hash;
  s.step = "await_pay_confirm";
  s.offer = undefined;
  s.pending = { slot: "pay", proposed: hash, kind: "bool", prompt: RECAP_PAY_ASK };
  rememberQuestion(stayOf(s), RECAP_PAY_ASK);
  persistBeforeAsk(persistSessionsNow);
  markSessionDirty();
}

/** After the quote: wait for recapHash confirm. Matching starts only after funded. */
async function presentQuoteAndWait(s: Session): Promise<void> {
  parkRecapWait(s);
  const quote = quoteLines(s);
  rememberItem(stayOf(s), s.selected?.productTitle ?? s.searchQuery ?? "");
  if (s.totalCents) rememberQuote(stayOf(s), s.totalCents);
  await say(s, quote, RECAP_PAY_ASK);
}

/** Matching only after the shopper is funded. */
async function beginMatchingAfterFund(s: Session): Promise<void> {
  const matchText = await runMatching(s);
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
  const city = handoverCity(s);
  if (s.ranked?.length) {
    await say(s, shopperWait(city));
    await lockTraveler(s, 0, { quoteAlreadyShown: true, silent: true });
    return;
  }
  await parkOpenRequest(s);
  await say(s, shopperNobody(city));
}

async function continueAfterListing(s: Session): Promise<void> {
  if (!s.deliveryCity) {
    parkDestAsk(s);
    await say(s, DEST_ASK);
    return;
  }
  if (!s.deadline) {
    await askNeedBy(s);
    return;
  }
  if (s.maxFeeCents == null) {
    await sayHost(s, stayOf(s).lastAct ?? "CONTINUE", parkEarningsAsk(s));
    return;
  }
  if (s.chatId) presenceTyping(s);
  await presentQuoteAndWait(s);
}

async function searchAndPromptListings(
  s: Session,
  extra?: NonNullable<Session["listings"]>,
): Promise<void> {
  if (!hasSerpApiKey()) {
    s.step = "done";
    markSessionDirty();
    await reply(s, "Store search isn’t hooked up on my side yet — try again later?");
    return;
  }
  const q = s.searchQuery!;
  let catalog: NonNullable<Session["listings"]> = [];
  try {
    const results = await withTimeout(
      searchProducts({
        query: q,
        shoppingCity: s.shoppingCity || undefined,
        merchant: s.merchantFilter,
      }),
      SERP_TIMEOUT_MS,
      "SerpAPI search",
    );
    catalog = results.listings;
  } catch (e: any) {
    console.warn(`[shopper-agent] search failed: ${e?.message ?? e}`);
    if (!extra?.length) {
      s.step = "await_product";
      markSessionDirty();
      if (e instanceof NoShopMarketError) {
        await reply(s, SKU_TOO_FEW);
        return;
      }
      await reply(s, `Search hiccupped on me. What should I look for instead?`);
      return;
    }
  }
  const seen = new Set<string>();
  const merged: NonNullable<Session["listings"]> = [];
  for (const l of [...(extra ?? []), ...catalog]) {
    if (seen.has(l.listingId)) continue;
    seen.add(l.listingId);
    merged.push(l);
  }
  const candidates = listingsForPicker(merged, 4);
  // #region agent log
  fetch("http://127.0.0.1:7792/ingest/af7dba43-916f-44eb-8996-041bf3055f0c", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ee46bb" },
    body: JSON.stringify({
      sessionId: "ee46bb",
      runId: "post-fix",
      hypothesisId: "E",
      location: "apps/shopper-agent/src/shopper-flow.mts:searchAndPromptListings",
      message: "picker gate",
      data: {
        query: q,
        merchantFilter: s.merchantFilter ?? null,
        catalogLen: catalog.length,
        extraLen: extra?.length ?? 0,
        mergedLen: merged.length,
        candidatesLen: candidates.length,
        tooFew: candidates.length < 2,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  console.warn("[shopper-debug]", JSON.stringify({ query: q, catalogLen: catalog.length, candidatesLen: candidates.length, tooFew: candidates.length < 2, merchantFilter: s.merchantFilter ?? null }));
  // #endregion
  if (candidates.length < 2) {
    s.listings = undefined;
    s.step = "await_product";
    s.offer = undefined;
    s.pending = null;
    markSessionDirty();
    await reply(s, SKU_TOO_FEW);
    return;
  }
  s.listings = candidates;
  await reply(s, SKU_FOUND, { thinkMs: 400 });
  for (let i = 0; i < candidates.length; i++) {
    const listing = candidates[i]!;
    const n = i + 1;
    if (listingHasPhoto(listing.imageUrl)) {
      await replyListing(s, listing, n);
    } else {
      await reply(
        s,
        listingCaption({
          title: listing.productTitle,
          merchant: listing.storeName,
          priceCents: listing.priceCents,
          n,
        }),
        { thinkMs: 400 },
      );
    }
  }
  parkListingPick(s);
}

function parkListingPick(s: Session, prompt = SKU_FOUND) {
  s.step = "await_listing";
  s.offer = undefined;
  s.pending = {
    slot: "listing",
    proposed: null,
    kind: "choice",
    prompt,
    options: (s.listings ?? []).map((l, i) => ({
      id: String(i + 1),
      label: listingCaption({
        title: l.productTitle,
        merchant: l.storeName,
        priceCents: l.priceCents,
        n: i + 1,
      }),
    })),
  };
  rememberQuestion(stayOf(s), prompt);
  persistBeforeAsk(persistSessionsNow);
  markSessionDirty();
}

async function filterOpenListingsToMerchant(s: Session, merchant: string): Promise<void> {
  const list = s.listings ?? [];
  const filtered = list.filter((l) => {
    const slug = l.storeSlug?.toLowerCase();
    if (slug === merchant) return true;
    const name = (l.storeName ?? "").toLowerCase();
    if (merchant === "bestbuy") return /best\s*buy/.test(name);
    if (merchant === "apple") return /\bapple\b/.test(name);
    return name.includes(merchant);
  });
  if (filtered.length === 1) {
    const idx = list.findIndex((l) => l.listingId === filtered[0]!.listingId);
    await selectListing(s, idx >= 0 ? idx : 0, merchant);
    return;
  }
  if (filtered.length >= 2) {
    s.listings = filtered;
    markSessionDirty();
    await reply(s, SKU_FOUND, { thinkMs: 300 });
    for (let i = 0; i < filtered.length; i++) {
      const listing = filtered[i]!;
      const n = i + 1;
      if (listingHasPhoto(listing.imageUrl)) await replyListing(s, listing, n);
      else {
        await reply(
          s,
          listingCaption({
            title: listing.productTitle,
            merchant: listing.storeName,
            priceCents: listing.priceCents,
            n,
          }),
          { thinkMs: 300 },
        );
      }
    }
    parkListingPick(s);
    return;
  }
  parkListingPick(s);
  await sayHost(s, "REASK", SKU_FOUND);
}

async function runSearchFlow(
  s: Session,
  extra?: NonNullable<Session["listings"]>,
): Promise<void> {
  s.selected = undefined;
  s.listings = extra;
  s.step = "await_listing";
  markSessionDirty();
  if (s.chatId) presenceTyping(s);
  await searchAndPromptListings(s, extra);
}

async function presentUrlCard(s: Session, listing: ProductListing): Promise<void> {
  if (!listingHasPhoto(listing.imageUrl) || !listing.productTitle.trim()) {
    const q = namedProduct(listing.productTitle) ?? listing.productTitle;
    s.searchQuery = q;
    rememberItem(stayOf(s), q);
    await runSearchFlow(s);
    return;
  }
  s.listings = [listing];
  s.searchQuery = listing.productTitle;
  s.selected = undefined;
  rememberItem(stayOf(s), listing.productTitle);
  markSessionDirty();
  const ok = await replyListing(s, listing);
  if (!ok) {
    s.searchQuery = namedProduct(listing.productTitle) ?? listing.productTitle;
    await runSearchFlow(s);
    return;
  }
  parkListingPick(s, "This one, or send another link / product name?");
}

async function intakeProductUrl(s: Session, url: string): Promise<void> {
  const listing = await listingFromProductUrl(url);
  if (listing && listing.productTitle && listingHasPhoto(listing.imageUrl)) {
    if (listing.priceCents > 0) {
      await presentUrlCard(s, listing);
      return;
    }
    const q = namedProduct(listing.productTitle) ?? listing.productTitle;
    s.searchQuery = q;
    rememberItem(stayOf(s), q);
    await runSearchFlow(s, [listing]);
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
  await runSearchFlow(s);
}

async function applyNewQuery(s: Session, query: string): Promise<void> {

  const url = extractHttpUrl(query);
  let extra: NonNullable<Session["listings"]> | undefined;
  if (url) {
    const fromLink = await listingFromProductUrl(url);
    if (fromLink) extra = [fromLink];
  }
  const stripped = query.replace(/https?:\/\/\S+/gi, "").trim();
  const item = namedProduct(stripped) ?? extra?.[0]?.productTitle ?? null;

  if (!item) {
    await sayHost(s, "REASK", parkItemAsk(s));
    return;
  }
  s.searchQuery = item;
  s.selected = undefined;
  s.listings = undefined;
  s.cart = undefined;
  s.recapHash = undefined;
  s.merchantFilter = parseMerchant(query) ?? parseMerchant(stripped) ?? undefined;
  const place = parseShopPlace(query) ?? parseShopPlace(stripped);
  if (place && shopMarketForCity(place)) s.shoppingCity = place;
  markSessionDirty();

  await runSearchFlow(s, extra);

}

async function selectListing(s: Session, idx: number, text = ""): Promise<void> {
  const list = s.listings ?? [];
  const parent = list[idx]!;
  const picked = resolveListingPick(parent, text);
  // #region agent log
  fetch("http://127.0.0.1:7792/ingest/af7dba43-916f-44eb-8996-041bf3055f0c", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ee46bb" },
    body: JSON.stringify({
      sessionId: "ee46bb",
      runId: "post-fix",
      hypothesisId: "G",
      location: "apps/shopper-agent/src/shopper-flow.mts:selectListing",
      message: "listing pick resolved",
      data: {
        idx,
        text: text.slice(0, 80),
        store: picked.storeName,
        title: picked.productTitle.slice(0, 72),
        priceCents: picked.priceCents,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  console.warn("[shopper-debug]", JSON.stringify({ pickIdx: idx, store: picked.storeName, priceCents: picked.priceCents, text: text.slice(0, 80) }));
  // #endregion
  s.selected = { ...picked };
  s.cart = { listingId: picked.listingId, qty: s.cart?.qty ?? 1 };
  s.category ??= categoryOf(s.selected.productTitle) ?? undefined;
  s.recapHash = undefined;
  clearPending(s);
  markSessionDirty();
  await continueAfterListing(s);
}

async function applyCartQty(s: Session, qty: number): Promise<void> {
  if (!s.selected) {
    await reaskOpen(s);
    return;
  }
  s.cart = { listingId: s.selected.listingId, qty };
  s.recapHash = undefined;
  markSessionDirty();
  if (s.maxFeeCents != null && s.deliveryCity && s.deadline) {
    await presentQuoteAndWait(s);
    return;
  }
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
  if (s.step === "await_max_fee" || s.offer?.field === "maxFeeCents" || s.pending?.slot === "delivery_fee") {
    s.offer = undefined;
    s.pending = {
      slot: "delivery_fee",
      proposed: null,
      kind: "money",
      prompt: EARNINGS_ASK,
    };
    rememberQuestion(stayOf(s), EARNINGS_ASK);
    return;
  }
  if (s.pending?.slot) return;
  if (s.offer && s.offer.field !== "listing") {
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
      s.pending?.prompt ||       `Want me to stretch your deadline to meet them? Just say yes or no.`,
    );
  } else if (s.step === "await_delivery_city") {
    if (s.deliveryCity) setOffer(s, "deliveryCity", s.deliveryCity, DEST_ASK);
    else parkDestAsk(s);

  } else if (s.step === "await_shopping_city") {
    if (s.searchQuery) s.step = "await_listing";
    else parkItemAsk(s);

  } else if (s.step === "await_product") {
    if (!s.pending?.slot) parkItemAsk(s);
  } else if (s.step === "await_listing" && s.listings?.length) {
    parkListingPick(s, s.pending?.prompt || SKU_FOUND);
  } else if (s.step === "await_pay_confirm" && !s.paySheetSent && !s.walletLinkSent && s.selected) {
    parkRecapWait(s);
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
        ? EARNINGS_ASK
        : s.step === "await_delivery_city"
          ? DEST_ASK
          : s.step === "await_shopping_city"
            ? shopperIntakeLine(s)

            : s.step === "await_product"
              ? shopperIntakeLine(s)
            : s.step === "await_listing"
              ? SKU_FOUND
              : s.step === "await_traveler"
                ? `Pick a traveler — a name or number from 1 to ${s.ranked?.length ?? 1}.`
                : s.step === "await_traveler_decision"
                  ? shopperWait(s.deliveryCity ?? "your city")
                  : s.step === "await_pay_confirm"
                    ? s.paySheetSent || s.walletLinkSent
                      ? `Open the pay link I sent — I’ll lock it once the charge lands.`
                      : RECAP_PAY_ASK
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
    commitShopPlace(s, turn.value);
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
  const phase =
    s.step === "await_handover_done"
      ? "shopping"
      : s.step === "await_traveler_decision"
        ? s.chosenTravelerId && stayOf(s).lastTravelerName
          ? "accepted"
          : "matching"
        : s.funded || s.handoverCode
          ? "funded"
          : null;
  if ((turn.meta === "status" || turn.meta === "wait") && phase) {
    await sayHost(s, "META", requestStatusLine(phase), turn.meta);
    return;
  }
  if (s.step === "await_pay_confirm" && (s.paySheetSent || s.walletLinkSent)) {
    if (!s.paySheetSent) {
      await confirmRecapPay(s);
      return;
    }
    await sayHost(
      s,
      "META",
      `Open the pay link I sent — I’ll lock it once the charge lands.`,
      turn.meta,
    );
    return;
  }
  if (s.step === "await_traveler_decision") {
    void syncWaitingShoppers();
    rememberWait(stayOf(s));
    await sayHost(s, "META", requestStatusLine("matching"), turn.meta);
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
      s.earningsReasked = undefined;
      clearPending(s);
      if (s.chatId) presenceTyping(s);
      await presentQuoteAndWait(s);
      return true;
    }
    if (!s.earningsReasked) {
      s.earningsReasked = true;
      markSessionDirty();
      await reply(s, EARNINGS_ASK);
      return true;
    }
    await reply(s, EARNINGS_ASK);
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
      await reply(s, `Open the pay link I sent — I’ll lock it once the charge lands.`);
      return true;
    }
    if (s.walletLinkSent) {
      await reply(s, `Add a test card (4242…) on the wallet link I sent — I’ll continue when it’s on file.`);
      return true;
    }
    await confirmRecapPay(s);
    return true;
  }
  if (!acceptsOffer(text, intent) || !s.offer) return false;
  const { field } = s.offer;
  const matches =
    (field === "shoppingCity" && s.step === "await_shopping_city") ||
    (field === "deliveryCity" && s.step === "await_delivery_city") ||
    (field === "deadline" && (s.step === "await_deadline" || s.step === "await_extend")) ||
    (field === "maxFeeCents" && s.step === "await_max_fee") ||
    (field === "traveler" && s.step === "await_traveler");
  if (!matches) return false;

  const value = takeOffer(s, field);
  if (value == null) return false;

  if (field === "shoppingCity") {
    if (!commitShopPlace(s, value)) return false;
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
    s.earningsReasked = undefined;
    markSessionDirty();
    if (s.chatId) presenceTyping(s);
    await presentQuoteAndWait(s);
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
  persistRecapTotal(s);
  markSessionDirty();
  if (!opts?.quoteAlreadyShown && !opts?.silent) {
    await say(s, quoteLines(s));
  }
  await parkWaitingOnTraveler(s, { silent: Boolean(opts?.silent) });
}

async function parkWaitingOnTraveler(s: Session, opts?: { silent?: boolean }): Promise<void> {
  const chosen = (s.ranked ?? []).find((t) => t.id === s.chosenTravelerId);
  const item = s.selected!;
  const city = handoverCity(s);
  const amounts = persistRecapTotal(s);
  const id = `req-${sessionKey(s.phone)}-${Date.now()}`;
  s.bidId = id;
  s.step = "await_traveler_decision";
  rememberItem(stayOf(s), item.productTitle);
  rememberQuote(stayOf(s), amounts.totalCents);
  rememberOffer(stayOf(s), id);
  rememberWait(stayOf(s));
  rememberQuestion(stayOf(s), shopperWait(city));
  clearPending(s);
  persistBeforeAsk(persistSessionsNow);
  try {
    const nextIdx = nextUntriedIndex(s.ranked ?? [], [...(s.triedTravelerIds ?? []), s.chosenTravelerId ?? ""]);
    const next = nextIdx != null ? (s.ranked ?? [])[nextIdx] : undefined;
    await writeOffer({
      id,
      travelerId: s.chosenTravelerId ?? "open",
      travelerName: chosen?.name ?? "Traveler",
      item: item.productTitle.slice(0, 80),
      itemCostCents: amounts.itemCents,
      travelerFeeCents: amounts.earningsCents,
      totalCents: amounts.totalCents,
      needBy: s.deadline ?? null,
      destinationCity: s.deliveryCity ?? null,
      bidId: id,
      escrowId: s.escrowId ?? "",
      handoverCode: s.handoverCode ?? "",
      status: "offered",
      shopperKey: sessionKey(s.phone),
      shopperChatId: s.chatId,
      notifiedShopper: false,
      notifiedTraveler: false,
      notifiedTravelerFunded: false,
      nextTravelerId: next?.id ?? null,
      nextTravelerName: item.storeName,
    });
  } catch (e: any) {
    console.warn(`[shopper-agent] marketplace offer skipped: ${e?.message ?? e}`);
  }
  if (!opts?.silent) {
    await say(s, shopperWait(city));
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
  await say(s, shopperNobody(handoverCity(s)));
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
  await say(s, shopperAccepted(city));
  if (s.handoverCode) {
    await say(
      s,
      `Your handover code is ${s.handoverCode}. Give that to the traveler when you meet and you’ve checked the item.`,
    );
  }
  s.step = "await_handover_done";
  clearPending(s);
  markSessionDirty();
  void totalCents;
}

async function sendFreshWalletLink(s: Session, recapTotalCents: number): Promise<boolean> {
  const identity = sessionKey(s.phone);
  dropConnection(identity);
  const link = await createWalletLink(identity);
  // #region agent log
  fetch("http://127.0.0.1:7792/ingest/af7dba43-916f-44eb-8996-041bf3055f0c", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ee46bb" },
    body: JSON.stringify({
      sessionId: "ee46bb",
      runId: "post-fix",
      hypothesisId: "P",
      location: "apps/shopper-agent/src/shopper-flow.mts:sendFreshWalletLink",
      message: "wallet_links sent",
      data: { hasUrl: Boolean(link.url), recapTotalCents },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  s.step = "await_pay_confirm";
  s.walletLinkSent = true;
  s.paySheetSent = false;
  s.paySheetAmountCents = recapTotalCents;
  s.offer = undefined;
  s.pending = {
    slot: "pay",
    proposed: recapTotalCents,
    kind: "bool",
    prompt: `Add a test card (4242…) so you can fund.`,
  };
  markSessionDirty();
  await say(s, `Add a test card (4242…) so you can fund.`, link.url);
  return true;
}

/** Wallet first if no card; pay-sheet once a card is on file. Recap confirm, not after accept. */
async function startFundingAfterAccept(s: Session, recapTotalCents: number): Promise<boolean> {
  const identity = sessionKey(s.phone);
  if (!agentcardConfigured()) {
    s.step = "await_pay_confirm";
    s.pending = { slot: "pay", proposed: s.recapHash ?? null, kind: "bool", prompt: PAYMENT_UNCONFIGURED };
    markSessionDirty();
    await say(s, PAYMENT_UNCONFIGURED);
    return true;
  }
  const card = await getConnectedCard(identity);
  const step = nextShopperFundingStep({
    configured: true,
    hasCard: Boolean(card),
    paySheetSent: Boolean(s.paySheetSent),
    demo: demoLocalChain(),
  });
  if (step === "anvil") {
    await fundAfterAccept(s);
    return true;
  }
  if (step === "wallet" || !card) {
    try {
      return await sendFreshWalletLink(s, recapTotalCents);
    } catch (e: any) {
      console.warn(`[shopper-agent] wallet link: ${e?.message ?? e}`);
      return false;
    }
  }
  if (step === "paysheet") {
    const opened = await openPaySheetAfterAccept(s, recapTotalCents);
    if (opened) return true;
    try {
      return await sendFreshWalletLink(s, recapTotalCents);
    } catch (e: any) {
      console.warn(`[shopper-agent] wallet link after pay-sheet: ${e?.message ?? e}`);
      return false;
    }
  }
  return step === "wait_payment";
}

async function confirmRecapPay(s: Session): Promise<void> {
  if (!s.selected) return;
  const hash = shownRecapHash(s);
  if (!s.recapHash || hash !== s.recapHash) {
    await presentQuoteAndWait(s);
    return;
  }
  const total = persistRecapTotal(s).totalCents;
  const started = await startFundingAfterAccept(s, total);
  if (started) return;
  if (agentcardConfigured()) {
    await say(s, PAYMENT_RETRY);
    return;
  }
  await say(s, PAYMENT_UNCONFIGURED);
}

/** Hosted pay-sheet after recap confirm. Amount is the recap total — do not recompute. Platform token mints the link. */
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
      `Fund ${formatUsd(sheet.amountCents)} with your card.`,
      sheet.url,
    );
    return true;
  } catch (e: any) {
    console.warn(`[shopper-agent] pay-sheet: ${e?.message ?? e}`);
    if (isAgentCardLoginError(e)) {
      dropConnection(sessionKey(s.phone));
    }
    return false;
  }
}

async function maybeCompleteAgentCardFund(s: Session): Promise<boolean> {
  if (s.step !== "await_pay_confirm" || s.handoverCode || s.escrowId) return false;
  if (!agentcardConfigured()) return false;
  const card = await getConnectedCard(sessionKey(s.phone));
  const step = nextShopperFundingStep({
    configured: true,
    hasCard: Boolean(card),
    paySheetSent: Boolean(s.paySheetSent),
    demo: demoLocalChain(),
  });
  if (step === "paysheet") {
    const total = s.paySheetAmountCents ?? persistRecapTotal(s).totalCents;
    const opened = await openPaySheetAfterAccept(s, total);
    if (opened) return true;
    try {
      return await sendFreshWalletLink(s, total);
    } catch (e: any) {
      console.warn(`[shopper-agent] wallet after pay-sheet login fail: ${e?.message ?? e}`);
      return false;
    }
  }
  return false;
}

/** Trust transaction.* webhooks after the pay-sheet — not the shopper saying done. */
export async function completeAgentCardPayment(identity?: string): Promise<void> {
  const key = identity ? sessionKey(identity) : null;
  for (const s of allSessions()) {
    if (s.step !== "await_pay_confirm" || !s.paySheetSent || s.handoverCode) continue;
    if (key && sessionKey(s.phone) !== key) continue;
    await fundAfterAccept(s);
  }
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
    const a = persistRecapTotal(s);
    const recapTotal = a.totalCents;
    const code = generateHandoverCode();
    s.handoverCode = code;
    s.totalCents = recapTotal;
    s.funded = true;
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
    await say(s, `Funded — ${formatUsd(recapTotal)}.`);
    await beginMatchingAfterFund(s);
    return;
  }
  if (!demoLocalChain()) {
    if (agentcardConfigured()) {
      console.warn("[shopper-agent] fundAfterAccept skipped — waiting on AgentCard payment webhook");
      return;
    }
    await say(s, PAYMENT_UNCONFIGURED);
    return;
  }
  await reply(s, `Opening escrow… one moment.`, { thinkMs: 600 });
  try {
    if (s.chatId) presenceTyping(s);
    const a = persistRecapTotal(s);
    const requestId = s.bidId;
    const out = await withTimeout(
      fundLocalEscrow({
        shopperUserId: s.phone,
        travelerId: s.chosenTravelerId && s.chosenTravelerId !== "open" ? s.chosenTravelerId : s.phone,
        itemCostCents: a.itemCents + a.taxCents,
        travelerFeeCents: a.earningsCents,
      }),
      ESCROW_TIMEOUT_MS,
      "escrow fund",
    );
    s.escrowId = out.escrowId;
    s.handoverCode = out.handoverCode;
    s.fundTxHash = out.fundTxHash;
    s.totalCents = a.totalCents;
    s.funded = true;
    s.offer = undefined;
    s.pending = null;
    markSessionDirty();
    if (requestId) {
      await updateOffer(requestId, {
        escrowId: out.escrowId,
        handoverCode: out.handoverCode,
        totalCents: a.totalCents,
        status: "funded",
        notifiedShopper: true,
        notifiedTravelerFunded: false,
      });
    }
    await say(s, `Funded — ${formatUsd(a.totalCents)} in escrow.`);
    await beginMatchingAfterFund(s);
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
          (s.step === "await_listing"
            ? SKU_FOUND
            : s.pending?.prompt?.trim() || shopperIntakeLine(s)),
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
    const place = parseShopPlace(slots.usCity);
    if (place && shopMarketForCity(place)) s.shoppingCity = place;
  }
  const dest = slots.deliveryCity ?? slots.ghCity;
  if (dest) s.deliveryCity = parseDeliveryTown(dest) ?? dest;
  if (slots.deadline) s.deadline = parseDate(slots.deadline) ?? undefined;
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

  await runSearchFlow(s);
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
    s.step !== "await_pay_confirm"
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
    if (turn.slot === "listing" && typeof turn.value === "string" && turn.value.startsWith("merchant:")) {
      await filterOpenListingsToMerchant(s, turn.value.slice("merchant:".length));
      return;
    }
    if (turn.slot === "listing" && turn.optionIndex != null) {
      await selectListing(s, turn.optionIndex, text);
      return;
    }
    if (turn.slot === "listing" && typeof turn.value === "number") {
      await applyCartQty(s, turn.value);
      return;
    }
    if (s.step === "await_pay_confirm" && closer && !s.paySheetSent && !s.walletLinkSent) {
      await confirmRecapPay(s);
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
      commitShopPlace(s, turn.value);
      clearPending(s);
      if (s.searchQuery) await runSearchFlow(s);
      else await sayHost(s, "REASK", parkItemAsk(s));
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

      if (commitShopPlace(s, decision.confirmedUsCity) && s.searchQuery) {
        await runSearchFlow(s);
        return;
      }
      if (s.searchQuery) {
        await runSearchFlow(s);
        return;
      }

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
    !parseMerchantName(intent.query) &&
    !parseMerchantName(text) &&
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
      const hyp = s.cognition?.pending?.hypothesis;
      const item = hyp ? parseItem(hyp) : namedProduct(s.searchQuery ?? "");
      if (item) {
        await commitConfirmedProduct(s, item);
        return;
      }
      await sayHost(s, "REASK", parkItemAsk(s));
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

      await applyNewQuery(s, query);

      return;
    }
    case "await_shopping_city": {
      // Catalog is national — leftover sessions search and move on. Do not ask shop-from city.
      if (s.searchQuery) {
        await runSearchFlow(s);
        return;
      }
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
        await selectListing(s, intent.index, text);
        return;
      }
      if (intent.kind === "new_query" && intent.query && !parseMerchantName(intent.query) && !parseMerchantName(text)) {
        await applyNewQuery(s, intent.query);
        return;
      }
      const list = s.listings ?? [];
      await reply(s, list.length ? SKU_FOUND : SKU_TOO_FEW);
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
        if (!s.earningsReasked) s.earningsReasked = true;
        markSessionDirty();
        await reply(s, EARNINGS_ASK);
        return;
      }
      if (intent.kind === "no") {
        const rest = text.replace(/^(n|no|nope|nah)[,.\s]*/i, "").trim();
        const cents = rest ? parseUsdCents(rest) : null;
        if (cents != null) {
          s.maxFeeCents = cents;
          s.earningsReasked = undefined;
          s.offer = undefined;
          markSessionDirty();
          if (s.chatId) presenceTyping(s);
          await presentQuoteAndWait(s);
          return;
        }
        if (!s.earningsReasked) s.earningsReasked = true;
        markSessionDirty();
        await reply(s, EARNINGS_ASK);
        return;
      }
      const cents = parseUsdCents(text);
      if (cents == null) {
        if (!s.earningsReasked) s.earningsReasked = true;
        markSessionDirty();
        await reply(s, EARNINGS_ASK);
        return;
      }
      s.maxFeeCents = cents;
      s.earningsReasked = undefined;
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
      await reply(s, shopperWait(handoverCity(s)));
      return;
    }
    case "await_traveler_decision": {
      await syncWaitingShoppers();
      const afterWait = s.step as string;
      if (afterWait === "await_pay_confirm") {
        if (s.paySheetSent) {
          await reply(s, `Open the pay link I sent — I’ll lock it once the charge lands.`);
          return;
        }
        if (s.walletLinkSent) {
          await reply(s, `Add a test card (4242…) on the wallet link I sent — I’ll continue when it’s on file.`);
          return;
        }
        await confirmRecapPay(s);
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
        await reply(s, shopperAccepted(s.deliveryCity ?? carry.destinationCity ?? "your city"));
        return;
      }
      if (s.offer?.field === "traveler") {
        await reply(s, shopperNobody(handoverCity(s)));
        return;
      }

      await reply(s, shopperWait(handoverCity(s)));
      return;
    }
    case "await_pay_confirm": {
      if (s.paySheetSent || s.walletLinkSent) {
        if (await maybeCompleteAgentCardFund(s)) return;
        await reply(
          s,
          s.paySheetSent
            ? `Open the pay link I sent — I’ll lock it once the charge lands.`
            : `Add a test card (4242…) on the wallet link I sent — I’ll continue when it’s on file.`,
        );
        return;
      }
      if (!isYes(text) && intent.kind !== "yes" && !acceptsOffer(text, intent)) {
        const qty = parseCartQty(text);
        if (qty != null && s.selected) {
          await applyCartQty(s, qty);
          return;
        }
        await reply(s, RECAP_PAY_ASK);
        return;
      }
      await confirmRecapPay(s);
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
