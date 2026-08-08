import { formatUsd, endOfLocalDay, computeFees, suggestedTravelerFeeCents } from "@manebra/shared";
import { normalizeCity } from "@manebra/calendar";
import { searchProducts, hasSerpApiKey } from "@manebra/catalog";
import { makeLlm, extractOrder } from "@manebra/llm";
import { rankTripsForItem, scoreMatch } from "@manebra/agents/matching";
import {
  type Session,
  getOrCreateSession,
  resetSession,
  parseDate,
  parseUsdCents,
  categoryOf,
  markSessionDirty,
} from "./session.mts";
import { classifyIntent, normalizeSearchQuery } from "./intent.mts";
import { sendText, startTyping, markChatRead } from "./linq-client.mts";
import { LINQ_TRAVELERS } from "./traveler-seeds.mts";
import {
  settlementEnabled,
  fundEscrowOrder,
  completeHandoverAndRelease,
} from "./settlement-bridge.mts";

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
  return LINQ_TRAVELERS.map((t) => ({
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

/** Typing bubble + paced send so it feels like a person, not a USSD menu. */
async function reply(s: Session, text: string, opts?: { thinkMs?: number }) {
  if (s.chatId) {
    void markChatRead(s.chatId);
    void startTyping(s.chatId);
  }
  const paced = opts?.thinkMs ?? Math.min(1800, Math.max(350, Math.round(text.length * 18)));
  await sleep(paced);
  const out = await sendText({ toPhone: s.phone, chatId: s.chatId, text });
  s.chatId = out.chatId;
  markSessionDirty();
  console.log(`[linq-agent] → ${s.phone}: ${text.slice(0, 80).replace(/\n/g, " ")}`);
}

/** 2–3 short bubbles (Ditto-style). */
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

function isYes(text: string): boolean {
  return /^(y|yes|ok|okay|sure|yeah|yep)\b/i.test(text.trim());
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

async function runMatching(s: Session): Promise<string> {
  const travelers = seedTravelers();
  const selected = s.selected!;
  const city = s.deliveryCity!;
  const deadline = endOfLocalDay(s.deadline!);
  const category = s.category ?? categoryOf(selected.productTitle) ?? "electronics";
  const itemRequest = {
    id: "item-linq",
    direction: "us_to_gh" as const,
    destinationCity: city,
    category,
    itemCostCents: selected.priceCents,
    status: "open" as const,
    reviewStatus: "auto_approved" as const,
    expiresAt: deadline,
  };
  const now = new Date();
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
    s.step = "done";
    markSessionDirty();
    return "I’m not finding a traveler for that city/date right now. Say hi anytime and we can try again.";
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
  s.step = "await_traveler";
  markSessionDirty();
  const lines = s.ranked.map((r, i) => `${i + 1}. ${r.name} — flies ${r.departs}`);
  return `Here’s who I’d trust for this:\n${lines.join("\n")}\n\nWho should I go with? A name or number works.`;
}

async function continueAfterListing(s: Session): Promise<void> {
  if (!s.deliveryCity) {
    s.step = "await_delivery_city";
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
    markSessionDirty();
    await reply(s, `When do you need it by? Something like “15th August” works.`);
    return;
  }
  if (s.maxFeeCents == null) {
    s.step = "await_max_fee";
    markSessionDirty();
    await reply(s, `What’s the most you’d pay the traveler in USD? Just a number is fine.`);
    return;
  }
  if (s.chatId) void startTyping(s.chatId);
  await reply(s, await runMatching(s), { thinkMs: 1400 });
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
    console.warn(`[linq-agent] search failed: ${e?.message ?? e}`);
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
  if (s.chatId) void startTyping(s.chatId);
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
    await say(s, `Got it — “${s.searchQuery}”.`, `Which US city should I shop in? New York is usually solid.`);
    return;
  }
  await runSearchFlow(s, `Got it — searching ${s.searchQuery} near ${s.shoppingCity}…`);
}

async function selectListing(s: Session, idx: number): Promise<void> {
  const list = s.listings ?? [];
  s.selected = list[idx]!;
  s.category ??= categoryOf(s.selected.productTitle) ?? undefined;
  markSessionDirty();
  await continueAfterListing(s);
}

/** Handle one inbound user message; replies are sent via Linq. */
export async function handleInbound(args: {
  phone: string;
  chatId: string | null;
  text: string;
}): Promise<void> {
  const text = args.text.trim();
  if (!text) return;

  const s = getOrCreateSession(args.phone, args.chatId);

  if (s.chatId) {
    void markChatRead(s.chatId);
    void startTyping(s.chatId);
  }

  try {
    await handleInboundInner(s, args, text);
  } catch (e: any) {
    console.error(`[linq-agent] handleInbound boom: ${e?.message ?? e}`);
    try {
      await reply(
        s,
        `I hit a snag on my side — still here though. Say hi to start fresh, or send that again.`,
        { thinkMs: 400 },
      );
    } catch (sendErr: any) {
      console.error(`[linq-agent] recovery reply failed: ${sendErr?.message ?? sendErr}`);
    }
  }
}

async function handleInboundInner(
  s: Session,
  args: { phone: string; chatId: string | null; text: string },
  text: string,
): Promise<void> {
  const intent = classifyIntent(text, {
    step: s.step,
    listingCount: s.listings?.length,
    travelerCount: s.ranked?.length,
    listingLabels: listingLabels(s),
    travelerLabels: travelerLabels(s),
  });

  if (intent.kind === "restart" || s.step === "idle" || s.step === "done") {
    resetSession(s);
    s.step = "await_product";
    markSessionDirty();
    await replyPair(
      s,
      "Hey — I’m Manebra.",
      "I help you buy from US stores and get it hand-carried to Ghana.\n\nWhat are you looking for?",
    );
    const rest = text.replace(/^(hi|hello|hey|start|restart|menu)\b[,!.\s]*/i, "").trim();
    if (!rest) return;
    return handleInbound({ ...args, text: rest });
  }

  if (intent.kind === "new_query" && intent.query && s.step !== "await_product") {
    await applyNewQuery(s, intent.query);
    return;
  }

  switch (s.step) {
    case "await_product": {
      let query = normalizeSearchQuery(text);
      const llm = makeLlm();
      if (llm && process.env.LINQ_LLM_EXTRACT !== "0") {
        try {
          const o = await Promise.race([
            extractOrder(llm, text),
            new Promise<null>((_, rej) => setTimeout(() => rej(new Error("extract timeout")), 3_000)),
          ]);
          if (o && (o as any).itemName) query = normalizeSearchQuery((o as any).itemName);
          if (o && (o as any).city) s.deliveryCity = normalizeCity((o as any).city) ?? (o as any).city;
          if (o && (o as any).deadline) s.deadline = parseDate((o as any).deadline) ?? undefined;
          if (o && (o as any).maxFeeUsd) s.maxFeeCents = Math.round((o as any).maxFeeUsd * 100);
          if (o && (o as any).category) s.category = (o as any).category;
        } catch (e: any) {
          console.warn(`[linq-agent] extractOrder skipped: ${e.message}`);
        }
      }
      s.searchQuery = query;
      s.step = "await_shopping_city";
      markSessionDirty();
      await say(s, `Okay, “${query}” — on it.`, `Which US city should I shop in? New York is usually solid.`);
      return;
    }
    case "await_shopping_city": {
      if (intent.kind === "reject_results") {
        s.step = "await_product";
        markSessionDirty();
        await reply(s, `No problem — what should I look for instead?`);
        return;
      }
      if (/^(ok|okay|sure|thanks|thank you|cool|great)\.?$/i.test(text)) {
        await reply(s, `Still on it — which US city should I search near?`);
        return;
      }
      s.shoppingCity = normalizeCity(text) ?? text;
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
        markSessionDirty();
        await reply(s, `Okay — what product should I search for?`);
        return;
      }
      s.deliveryCity = normalizeCity(text) ?? text;
      markSessionDirty();
      await continueAfterListing(s);
      return;
    }
    case "await_deadline": {
      const d = parseDate(text);
      if (!d) {
        await reply(s, `I didn’t catch that date — try something like “15th August”.`);
        return;
      }
      s.deadline = d;
      markSessionDirty();
      await continueAfterListing(s);
      return;
    }
    case "await_max_fee": {
      const cents = parseUsdCents(text);
      if (cents == null) {
        await reply(s, `Just the dollar amount is fine — like 40.`);
        return;
      }
      s.maxFeeCents = cents;
      markSessionDirty();
      if (s.chatId) void startTyping(s.chatId);
      await reply(s, await runMatching(s), { thinkMs: 1400 });
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
      if (s.chatId) void startTyping(s.chatId);
      await reply(s, await runMatching(s), { thinkMs: 1200 });
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
      const chosen = ranked[idx]!;
      s.chosenTravelerId = chosen.id;
      const item = s.selected!;
      const fee = suggestedTravelerFeeCents(item.priceCents);
      const capped = Math.min(fee, s.maxFeeCents ?? fee);
      const fees = computeFees(item.priceCents, capped);
      s.totalCents = fees.totalCents;
      markSessionDirty();

      if (!settlementEnabled()) {
        s.step = "done";
        markSessionDirty();
        await say(
          s,
          `Locked in with ${chosen.name} (${chosen.departs}).`,
          `${item.productTitle.slice(0, 80)}\n` +
            `About ${formatUsd(fees.totalCents)} all-in (item + traveler + platform).\n\n` +
            `Payment wiring is off in this build — say hi for another order anytime.`,
        );
        return;
      }

      s.step = "await_pay_confirm";
      markSessionDirty();
      await say(
        s,
        `I’d match you with ${chosen.name} — they fly ${chosen.departs}.`,
        `${item.productTitle.slice(0, 80)}\n\n` +
          `Total comes to about ${formatUsd(fees.totalCents)} in test USDC (sandbox — not real money).\n` +
          `Want me to lock escrow? Just say yes.`,
      );
      return;
    }
    case "await_pay_confirm": {
      if (!isYes(text) && intent.kind !== "yes") {
        s.step = "done";
        markSessionDirty();
        await reply(s, `No worries — nothing moved. Say hi whenever.`);
        return;
      }
      await reply(s, `Opening escrow… one moment.`, { thinkMs: 600 });
      try {
        if (s.chatId) void startTyping(s.chatId);
        const out = await withTimeout(
          fundEscrowOrder({
            phone: s.phone,
            travelerId: s.chosenTravelerId!,
            selected: s.selected!,
            deliveryCity: s.deliveryCity!,
            deadline: s.deadline!,
            shoppingCity: s.shoppingCity,
            maxFeeCents: s.maxFeeCents!,
            category: s.category ?? categoryOf(s.selected!.productTitle) ?? undefined,
          }),
          ESCROW_TIMEOUT_MS,
          "escrow fund",
        );
        s.bidId = out.bidId;
        s.escrowId = out.escrowId;
        s.handoverCode = out.handoverCode;
        s.fundTxHash = out.fundTxHash;
        s.totalCents = out.totalCents;
        s.step = "await_handover_done";
        markSessionDirty();
        await say(
          s,
          `Funded — ${formatUsd(out.totalCents)} in escrow.`,
          `Your handover code is ${out.handoverCode}. Give that to the traveler when you meet and you’ve checked the item.\n\n` +
            `When it’s done, just text done.`,
        );
      } catch (e: any) {
        s.step = "done";
        markSessionDirty();
        console.error(`[linq-agent] settlement error: ${e.message}`);
        await reply(
          s,
          `Couldn’t finish escrow on my side. Say hi to try again — we’ll sort the chain setup.`,
        );
      }
      return;
    }
    case "await_handover_done": {
      if (!/^(done|delivered|complete|yes)\b/i.test(text.trim())) {
        await reply(s, `Whenever you’ve got the item, text done. Your code is still ${s.handoverCode}.`);
        return;
      }
      try {
        if (s.chatId) void startTyping(s.chatId);
        await reply(s, `Releasing escrow…`, { thinkMs: 500 });
        const out = await withTimeout(
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
        console.error(`[linq-agent] handover error: ${e.message}`);
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
