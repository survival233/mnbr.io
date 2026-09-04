import * as linq from "./linq-client.mts";
import * as relay from "./relay-client.mts";
import {
  getOrCreateSession,
  resetSession,
  markSessionDirty,
  hasTripProgress,
  allSessions,
  appendDialogTurn,
  sessionKey,
  type Session,
} from "./session.mts";
import { handleTravelInbound, sendTravelerWallet, resumeAfterTravelerCard } from "./travel-flow.mts";
import { blankTrip } from "./trip-state.mts";
import {
  getOpenOfferForTraveler,
  getActiveOfferForTraveler,
  acceptOfferIfOpen,
  updateOffer,
  getTravelerCard,
  setConnectedCard,
} from "@manebra/db";
import { agentcardConfigured, buyWithUserCard } from "@repo/agentcard";
import { settleLocalEscrow } from "@manebra/settlement/server/local-escrow";
import { isTravelIntent } from "@manebra/flights";
import { hubCity, sameMetro } from "@manebra/geo";
import {
  classifyTurn,
  composeHostReply,
  HOSPITALITY_PERSONA,
  TRAVELER_SLOT_SCHEMA,
  ensureStay,
  rememberQuestion,
  rememberItem,
  rememberOffer,
  rememberWait,
  travelerAsk,
  guestCityName,
  TRAVELER_SKU_GONE,
  TRAVELER_OVER_CAP,
  TRAVELER_HI,
  TRAVELER_WALLET_ADD,
  type DialogSession,
} from "@manebra/dialog";
import { offerBelongsToTraveler } from "./offer-fit.mts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function relayIdempotencyKey(s: Session, text: string, attempt = 0): string {
  let tag = 0;
  for (let i = 0; i < text.length; i++) tag = (Math.imul(tag, 33) + text.charCodeAt(i)) >>> 0;
  const base = `reply-${s.relayEventId ?? "na"}-${s.relayReplySeq}-${tag.toString(16)}`;
  return attempt > 0 ? `${base}-r${attempt}` : base;
}

void TRAVELER_SLOT_SCHEMA;
void HOSPITALITY_PERSONA;

function stayOf(s: Session) {
  s.stay = ensureStay(s.stay);
  return s.stay;
}

function asDialog(s: Session): DialogSession {
  const trip = s.trip;
  return {
    step: s.step,
    searchQuery: trip?.destination || trip?.origin || stayOf(s).lastItem || undefined,
    pending: s.pending ?? null,
    offer: s.offer,
    stay: stayOf(s),
    turns: s.turns,
  };
}

async function sayHost(s: Session, act: Parameters<typeof composeHostReply>[0]["act"], next?: string, meta?: Parameters<typeof composeHostReply>[0]["meta"]) {
  await say(s, ...composeHostReply({ act, meta, stay: stayOf(s), next }));
}

async function reply(s: Session, text: string, opts?: { thinkMs?: number }) {
  if (text?.trim()) appendDialogTurn(s, "assistant", text);
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
        console.warn(`[traveler-agent] relay idempotency conflict; retrying (attempt ${attempt + 1})`);
      }
    }
    if (lastErr) throw lastErr;
    void relay.stopTyping(s.chatId);
    markSessionDirty();
    console.log(`[traveler-agent] → relay ${s.phone}: ${text.slice(0, 80).replace(/\n/g, " ")}`);
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
  console.log(`[traveler-agent] → linq ${s.phone}: ${text.slice(0, 80).replace(/\n/g, " ")}`);
}

async function say(s: Session, ...bubbles: string[]) {
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i]!;
    if (!b?.trim()) continue;
    await reply(s, b, {
      thinkMs: i === 0 ? 450 + Math.floor(Math.random() * 350) : 550 + Math.floor(Math.random() * 450),
    });
  }
}

function travelerDestination(s: Session): string | null {
  const raw = s.trip?.destination ?? s.travelDestination;
  if (!raw?.trim()) return null;
  return guestCityName(raw) ?? hubCity(raw) ?? raw.trim();
}

function offerFitsThisTraveler(
  s: Session,
  offer: { travelerId?: string | null; destinationCity?: string | null },
): boolean {
  if (!offerBelongsToTraveler(offer, s.phone)) return false;
  const dest = travelerDestination(s);
  if (dest && offer.destinationCity && !sameMetro(offer.destinationCity, dest)) return false;
  return true;
}

function requestInvite(s: Session, offer: {
  item: string;
  itemCostCents?: number;
  travelerFeeCents: number;
  totalCents: number;
  needBy: Date | null;
  destinationCity?: string | null;
  nextTravelerName?: string | null;
}): string[] {
  const dest = offer.destinationCity ?? travelerDestination(s) ?? "your city";
  const merchant = offer.nextTravelerName?.trim() || "the store";
  return travelerAsk({
    city: dest,
    title: offer.item,
    merchant,
    itemCents: offer.itemCostCents ?? 0,
    earningsCents: offer.travelerFeeCents || 0,
  });
}

/** Recap quote is item+tax+earnings. Live register may only spend item+tax. */
function fundedItemAndTaxCap(offer: {
  totalCents?: number;
  travelerFeeCents?: number;
  itemCostCents?: number;
}): number {
  if (offer.totalCents != null && offer.travelerFeeCents != null) {
    return Math.max(0, offer.totalCents - offer.travelerFeeCents);
  }
  return offer.itemCostCents ?? 0;
}

function parseLiveCartCents(reply: string): number | null {
  let best: number | null = null;
  for (const m of reply.matchAll(/\$(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})/g)) {
    const n = Math.round(Number(m[1]!.replace(/,/g, "")) * 100);
    if (Number.isFinite(n) && n > 0 && (best == null || n > best)) best = n;
  }
  return best;
}

/** Traveler store checkout AFTER shopper funded. Never the shopper catalog, never at recap. */
async function startTravelerBuy(
  s: Session,
  carry: {
    item: string;
    nextTravelerName?: string | null;
    totalCents?: number;
    travelerFeeCents?: number;
    itemCostCents?: number;
  },
  similar = false,
): Promise<void> {
  if (s.travelerBuyStarted && !similar) return;
  s.travelerBuyStarted = true;
  s.skuGoneAsk = undefined;
  markSessionDirty();
  const merchant = carry.nextTravelerName?.trim() || "the store";
  const ask = similar
    ? `Buy a similar listing to ${carry.item} at ${merchant}`
    : `Buy ${carry.item} at ${merchant}`;
  const cap = fundedItemAndTaxCap(carry);
  try {
    const turn = await buyWithUserCard(sessionKey(s.phone), ask);
    const replyText = turn.reply?.trim() ?? "";
    if (/out of stock|unavailable|sold out|no longer available|couldn'?t find|not found/i.test(replyText)) {
      s.travelerBuyStarted = false;
      s.skuGoneAsk = true;
      markSessionDirty();
      await say(s, TRAVELER_SKU_GONE);
      return;
    }
    const live = parseLiveCartCents(replyText);
    if (cap > 0 && live != null && live > cap) {
      s.travelerBuyStarted = false;
      markSessionDirty();
      await say(s, TRAVELER_OVER_CAP);
      return;
    }
    if (replyText) await say(s, replyText);
  } catch (e: any) {
    s.travelerBuyStarted = false;
    s.skuGoneAsk = true;
    markSessionDirty();
    console.warn(`[traveler-agent] AgentCard buy: ${e?.message ?? e}`);
    await say(s, TRAVELER_SKU_GONE);
  }
}

/** Ping matching travelers when a shopper request appears or funds land. */
export async function syncTravelerMarketplace(): Promise<void> {
  for (const s of allSessions()) {
    if (!s.chatId) continue;
    const open = await getOpenOfferForTraveler(s.phone);
    if (open && !open.notifiedTraveler && offerFitsThisTraveler(s, open)) {
      await updateOffer(open.id, { notifiedTraveler: true });
      rememberItem(stayOf(s), open.item);
      rememberOffer(stayOf(s), open.id);
      rememberQuestion(stayOf(s), "Want it?");
      await say(s, ...requestInvite(s, open));
      continue;
    }

    const carry = await getActiveOfferForTraveler(s.phone);
    if (carry?.status !== "funded") continue;

    const onFile = await getTravelerCard(sessionKey(s.phone));
    if (!carry.notifiedTravelerFunded) {
      await updateOffer(carry.id, { notifiedTravelerFunded: true });
      await say(
        s,
        `Shopper funded — ${carry.item} is ready.`,
        onFile
          ? `Shop with your card. When you meet, enter their 6-digit handover code.`
          : `When you meet, enter their 6-digit handover code.`,
      );
      if (agentcardConfigured() && !onFile) {
        await sendTravelerWallet(s, { say });
      }
    }
    if (agentcardConfigured() && onFile) {
      await startTravelerBuy(s, carry);
    }
  }
}

/** Card webhook may only carry AgentCard user_id. Stamp waiting Relay sessions so the traveler's own card is on file. */
export async function attachWebhookCardToWaitingTravelers(webhookIdentity?: string): Promise<void> {
  for (const s of allSessions()) {
    if (s.step !== "await_traveler_card") continue;
    const id = sessionKey(s.phone);
    if (!(await getTravelerCard(id))) {
      await setConnectedCard({
        identity: id,
        agentcardUserId: webhookIdentity ?? null,
        isDefault: true,
      });
    }
    await resumeAfterTravelerCard(s, { reply, say });
  }
}

async function tryHandleMarketplaceOffer(
  s: Session,
  text: string,
  io: { reply: typeof reply; say: typeof say },
): Promise<boolean> {
  const open = await getOpenOfferForTraveler(s.phone);
  const active = await getActiveOfferForTraveler(s.phone);
  const listed = open && offerFitsThisTraveler(s, open) ? open : null;
  const inFlight =
    active &&
    active.status !== "offered" &&
    (offerFitsThisTraveler(s, active) || stayOf(s).lastOfferId === active.id)
      ? active
      : null;
  const carry = listed ?? inFlight;
  if (!carry) return false;

  if (s.skuGoneAsk) {
    if (/\bsimilar\b/i.test(text)) {
      await startTravelerBuy(s, carry, true);
      return true;
    }
    if (/^(n|no|nope|nah|cancel)\b/i.test(text)) {
      s.skuGoneAsk = undefined;
      markSessionDirty();
      await updateOffer(carry.id, { status: "cancelled", notifiedShopper: false });
      await io.say(s, `Cancelled. I won’t swap it.`);
      return true;
    }
    if (/\btext\b/i.test(text) || /shopper/i.test(text)) {
      s.skuGoneAsk = undefined;
      markSessionDirty();
      await updateOffer(carry.id, { notifiedShopper: false });
      await io.say(s, `I’ll tell the shopper.`);
      return true;
    }
    await io.say(s, TRAVELER_SKU_GONE);
    return true;
  }

  const yes = /^(y|yes|ok|okay|sure|yeah|yep|accept)\b/i.test(text);
  const no = /^(n|no|nope|nah|decline|can'?t)\b/i.test(text);
  const flights = /^(skip|flights?)\b/i.test(text);
  const confirm = /^(confirm|done|delivered|complete)\b/i.test(text);
  const code = text.match(/\b(\d{6})\b/)?.[1];

  if (carry.status === "offered") {
    if (yes) {
      const accepted = await acceptOfferIfOpen(carry.id);
      if (!accepted) {
        await io.say(s, `That request is no longer open.`);
        return true;
      }
      rememberItem(stayOf(s), accepted.item);
      rememberOffer(stayOf(s), accepted.id);
      rememberWait(stayOf(s));
      await io.say(s, `Accepted.`);
      if (agentcardConfigured()) {
        const onFile = await getTravelerCard(sessionKey(s.phone));
        if (!onFile) {
          await sendTravelerWallet(s, io);
        } else {
          await startTravelerBuy(s, accepted);
        }
      }
      await updateOffer(accepted.id, {
        status: "funded",
        handoverCode: accepted.handoverCode,
        notifiedTravelerFunded: true,
      });
      return true;
    }
    if (no) {
      await updateOffer(carry.id, { status: "declined", notifiedShopper: false });
      await io.say(s, `Declined. I’ll look for another Shop & Deliver.`);
      return true;
    }
    if (flights || isTravelIntent(text)) return false;
    await io.say(s, ...requestInvite(s, carry));
    return true;
  }

  if (carry.status === "accepted") {
    if (agentcardConfigured()) {
      const onFile = await getTravelerCard(sessionKey(s.phone));
      if (onFile) await startTravelerBuy(s, carry);
      else await io.reply(s, TRAVELER_WALLET_ADD);
    } else {
      await io.reply(s, `Accepted.`);
    }
    return true;
  }

  if (carry.status === "funded") {
    const entered = code ?? (confirm ? carry.handoverCode : null);
    if (entered && entered === carry.handoverCode) {
      try {
        await settleLocalEscrow({ escrowId: carry.escrowId as `0x${string}`, action: "release" });
        await updateOffer(carry.id, { status: "released" });
        await io.reply(s, `Handover confirmed — escrow released. You’re paid (test USDC).`);
      } catch (e: any) {
        console.error(`[traveler-agent] local release: ${e?.message ?? e}`);
        await io.reply(s, `Couldn’t release escrow — ${e?.message ?? e}`);
      }
      return true;
    }
    await io.reply(s, `Enter the 6-digit handover code from the shopper (or say confirm).`);
    return true;
  }

  return false;
}

export async function handleInbound(args: {
  phone: string;
  chatId: string | null;
  text: string;
  channel?: "linq" | "relay";
  relayEventId?: string;
  relayMessageId?: string;
}): Promise<void> {
  const text = (args.text ?? "").trim();
  const s = getOrCreateSession(args.phone, args.chatId, {
    channel: args.channel ?? "linq",
    relayEventId: args.relayEventId,
    relayMessageId: args.relayMessageId,
  });
  if (text) appendDialogTurn(s, "user", text);

  const greetingOnly = /^(hi|hello|hey|start|menu)\b[,!.\s]*$/i.test(text);
  const restart = /^(restart|start over|reset)\b/i.test(text);
  if (restart) {
    resetSession(s);
    s.trip = blankTrip();
    s.step = "await_travel_intent";
    markSessionDirty();
  }

  // Greeting is the menu — never the dest slot. classifyTurn treats hi as REASK.
  if (greetingOnly || restart) {
    s.step = "await_travel_intent";
    s.pending = null;
    markSessionDirty();
    await say(s, TRAVELER_HI);
    return;
  }

  if (!isTravelIntent(text)) {
    if (await tryHandleMarketplaceOffer(s, text, { reply, say })) return;
  }

  const turn = classifyTurn(asDialog(s), { text });
  stayOf(s).lastAct = turn.act;
  const midTrip = hasTripProgress(s) || Boolean(stayOf(s).lastItem || stayOf(s).lastOfferId);

  if (turn.act === "META" && turn.meta === "cancel") {
    resetSession(s);
    s.trip = blankTrip();
    s.step = "await_travel_intent";
    markSessionDirty();
    await say(s, TRAVELER_HI);
    return;
  }
  if (turn.act === "META") {
    await sayHost(s, "META", stayOf(s).lastQuestion || "Your trip.", turn.meta);
    return;
  }

  // Coming back or a short reply is the same stay — do not wipe intake.
  if (turn.act !== "NEW" && midTrip) {
    await handleTravelInbound(s, text, { reply, say });
    return;
  }

  if ((s.step === "done" || (s.step === "idle" && !midTrip)) && turn.act === "NEW") {
    if (s.step === "done") {
      resetSession(s);
      s.trip = blankTrip();
      s.step = "await_travel_intent";
      markSessionDirty();
    } else if (s.step === "idle" && !midTrip) {
      s.trip = s.trip ?? blankTrip();
      s.step = "await_travel_intent";
      markSessionDirty();
    }
  }

  await handleTravelInbound(s, text, { reply, say });
}
