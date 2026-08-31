import * as linq from "./linq-client.mts";
import * as relay from "./relay-client.mts";
import {
  getOrCreateSession,
  resetSession,
  markSessionDirty,
  hasTripProgress,
  allSessions,
  appendDialogTurn,
  type Session,
} from "./session.mts";
import { handleTravelInbound } from "./travel-flow.mts";
import { blankTrip } from "./trip-state.mts";
import {
  latestOpenOffer,
  latestActiveOffer,
  updateOffer,
  getTravelerCard,
} from "@manebra/db";
import { agentcardConfigured, createWalletLink } from "@repo/agentcard";
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
  type DialogSession,
} from "@manebra/dialog";

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
  return hubCity(raw) ?? raw.trim();
}

function offerFitsThisTraveler(s: Session, offer: { destinationCity?: string | null }): boolean {
  const dest = travelerDestination(s);
  if (!dest || !offer.destinationCity) return false;
  return sameMetro(offer.destinationCity, dest);
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

function latestTravelerSession(): Session | null {
  const withChat = allSessions().filter((s) => s.chatId);
  if (!withChat.length) return null;
  return withChat.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** Ping matching travelers when a shopper request appears or funds land. */
export async function syncTravelerMarketplace(): Promise<void> {
  const sessions = allSessions().filter((s) => s.chatId);
  const open = await latestOpenOffer();
  if (open && !open.notifiedTraveler) {
    const matches = sessions.filter((s) => offerFitsThisTraveler(s, open));
    if (matches.length) {
      await updateOffer(open.id, { notifiedTraveler: true });
      for (const s of matches) {
        rememberItem(stayOf(s), open.item);
        rememberOffer(stayOf(s), open.id);
        rememberQuestion(stayOf(s), "Want it?");
        await say(s, ...requestInvite(s, open));
      }
      return;
    }
  }

  const s = latestTravelerSession();
  if (!s?.chatId) return;
  const carry = await latestActiveOffer();
  if (carry?.status === "funded" && !carry.notifiedTravelerFunded) {
    await updateOffer(carry.id, { notifiedTravelerFunded: true });
    const onFile = await getTravelerCard(s.phone);
    await say(
      s,
      `Shopper funded — ${carry.item} is locked in escrow.`,
      onFile
        ? `Shop with your card on file. When you meet, enter their 6-digit handover code.`
        : `When you meet, enter their 6-digit handover code.`,
    );
    if (agentcardConfigured() && !onFile) {
      try {
        const link = await createWalletLink(s.phone);
        await say(s, `Add a test card (4242…) so you can shop with yours.`, link.url);
      } catch (e: any) {
        console.warn(`[traveler-agent] wallet link: ${e?.message ?? e}`);
      }
    }
  }
}

async function tryHandleMarketplaceOffer(
  s: Session,
  text: string,
  io: { reply: typeof reply; say: typeof say },
): Promise<boolean> {
  const open = await latestOpenOffer();
  const active = await latestActiveOffer();
  const listed = open && offerFitsThisTraveler(s, open) ? open : null;
  const inFlight =
    active &&
    active.status !== "offered" &&
    (offerFitsThisTraveler(s, active) || stayOf(s).lastOfferId === active.id)
      ? active
      : null;
  const carry = listed ?? inFlight;
  if (!carry) return false;

  const yes = /^(y|yes|ok|okay|sure|yeah|yep|accept)\b/i.test(text);
  const no = /^(n|no|nope|nah|decline|can'?t)\b/i.test(text);
  const flights = /^(skip|flights?)\b/i.test(text);
  const confirm = /^(confirm|done|delivered|complete)\b/i.test(text);
  const code = text.match(/\b(\d{6})\b/)?.[1];

  if (carry.status === "offered") {
    if (yes) {
      await updateOffer(carry.id, {
        status: "accepted",
        notifiedShopper: false,
        travelerId: s.phone,
        travelerName: "Traveler",
      });
      rememberItem(stayOf(s), carry.item);
      rememberOffer(stayOf(s), carry.id);
      rememberWait(stayOf(s));
      await io.say(s, `Accepted. Waiting for the shopper to fund — no Shop & Deliver until then.`);
      if (agentcardConfigured()) {
        const onFile = await getTravelerCard(s.phone);
        if (!onFile) {
          try {
            const link = await createWalletLink(s.phone);
            await io.say(
              s,
              `Add a test card (4242…) so you can shop with yours — never the shopper’s.`,
              link.url,
            );
          } catch (e: any) {
            console.warn(`[traveler-agent] wallet link: ${e?.message ?? e}`);
          }
        }
      }
      return true;
    }
    if (no) {
      await updateOffer(carry.id, { status: "declined", notifiedShopper: false });
      await io.say(s, `Declined. I’ll let the shopper know.`);
      return true;
    }
    if (flights || isTravelIntent(text)) return false;
    await io.say(s, ...requestInvite(s, carry));
    return true;
  }

  if (carry.status === "accepted") {
    await io.reply(s, `Waiting for the shopper to fund.`);
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

  const greetingOnly = /^(hi|hello|hey|start|restart|menu)\b[,!.\s]*$/i.test(text);
  const restart = /^(restart|start over|reset|menu)\b/i.test(text);
  // Flights first. Leftover accepted offers must not swallow “hi”.
  if (greetingOnly || restart) {
    resetSession(s);
    s.trip = blankTrip();
    s.step = "await_travel_intent";
    markSessionDirty();
  } else if (!isTravelIntent(text)) {
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
    await sayHost(s, "META", "Where are you flying?", "cancel");
    return;
  }
  if (turn.act === "META") {
    await sayHost(s, "META", stayOf(s).lastQuestion || "Still on your trip.", turn.meta);
    return;
  }

  // Coming back or a short reply is the same stay — do not wipe intake.
  if (turn.act !== "NEW" && midTrip) {
    await handleTravelInbound(s, text, { reply, say });
    return;
  }

  if ((restart || (greetingOnly && !midTrip) || s.step === "done" || (s.step === "idle" && !midTrip)) && turn.act === "NEW") {
    if (restart || s.step === "done") {
      resetSession(s);
      s.trip = blankTrip();
      s.step = "await_travel_intent";
      markSessionDirty();
    } else if (s.step === "idle" && !midTrip) {
      s.trip = s.trip ?? blankTrip();
      s.step = "await_travel_intent";
      markSessionDirty();
    }

    if (greetingOnly || restart || !text) {
      await sayHost(
        s,
        turn.act,
        "Where are you flying? Origin, destination, and day — I’ll find options, then Shop & Deliver requests on that route.",
      );
      if (greetingOnly || restart) {
        const rest = text
          .replace(/^(hi|hello|hey|start|restart|menu|start over|reset)\b[,!.\s]*/i, "")
          .trim();
        if (!rest) return;
        await handleTravelInbound(s, rest, { reply, say });
      }
      return;
    }
  }

  await handleTravelInbound(s, text, { reply, say });
}
