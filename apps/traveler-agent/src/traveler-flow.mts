import * as linq from "./linq-client.mts";
import * as relay from "./relay-client.mts";
import {
  getOrCreateSession,
  resetSession,
  markSessionDirty,
  hasTripProgress,
  allSessions,
  type Session,
} from "./session.mts";
import { handleTravelInbound } from "./travel-flow.mts";
import { blankTrip } from "./trip-state.mts";
import {
  latestOpenOffer,
  latestActiveOffer,
  updateOffer,
} from "@manebra/db";
import { isTravelIntent } from "@manebra/flights";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function relayIdempotencyKey(s: Session, text: string, attempt = 0): string {
  let tag = 0;
  for (let i = 0; i < text.length; i++) tag = (Math.imul(tag, 33) + text.charCodeAt(i)) >>> 0;
  const base = `reply-${s.relayEventId ?? "na"}-${s.relayReplySeq}-${tag.toString(16)}`;
  return attempt > 0 ? `${base}-r${attempt}` : base;
}

async function reply(s: Session, text: string, opts?: { thinkMs?: number }) {
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

function carryUsd(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

function latestTravelerSession(): Session | null {
  const withChat = allSessions().filter((s) => s.chatId);
  if (!withChat.length) return null;
  return withChat.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** Ping Traveler when a shopper request appears or funds land (shared marketplace store). */
export async function syncTravelerMarketplace(): Promise<void> {
  const s = latestTravelerSession();
  if (!s?.chatId) return;

  const open = await latestOpenOffer();
  if (open && !open.notifiedTraveler) {
    await updateOffer(open.id, { notifiedTraveler: true });
    await say(
      s,
      `New carry request: ${open.item} — about ${carryUsd(open.totalCents)}.`,
      `Accept or decline?`,
    );
    return;
  }

  const carry = await latestActiveOffer();
  if (carry?.status === "funded" && !carry.notifiedTravelerFunded) {
    await updateOffer(carry.id, { notifiedTravelerFunded: true });
    await say(
      s,
      `Shopper funded — ${carry.item} is locked in escrow.`,
      `When you meet, enter their 6-digit handover code.`,
    );
  }
}

async function tryHandleMarketplaceOffer(
  s: Session,
  text: string,
  io: { reply: typeof reply; say: typeof say },
): Promise<boolean> {
  const open = await latestOpenOffer();
  const active = await latestActiveOffer();
  const carry = open ?? (active && active.status !== "offered" ? active : null);
  if (!carry) return false;

  const yes = /^(y|yes|ok|okay|sure|yeah|yep|accept)\b/i.test(text);
  const no = /^(n|no|nope|nah|decline|can'?t)\b/i.test(text);
  const flights = /^(skip|flights?)\b/i.test(text);
  const confirm = /^(confirm|done|delivered|complete)\b/i.test(text);
  const code = text.match(/\b(\d{6})\b/)?.[1];

  if (carry.status === "offered") {
    if (yes) {
      await updateOffer(carry.id, { status: "accepted", notifiedShopper: false });
      await io.say(s, `Accepted. Waiting for the shopper to fund — no carry until then.`);
      return true;
    }
    if (no) {
      await updateOffer(carry.id, { status: "declined", notifiedShopper: false });
      await io.say(s, `Declined. I’ll let the shopper know.`);
      return true;
    }
    if (flights || isTravelIntent(text)) return false;
    await io.say(
      s,
      `Carry request: ${carry.item} — about ${carryUsd(carry.totalCents)}.`,
      `Accept or decline?`,
    );
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
        const { settleLocalEscrow } = await import("../../agent-cli/src/local-escrow.mts");
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

  if (await tryHandleMarketplaceOffer(s, text, { reply, say })) return;

  const greetingOnly = /^(hi|hello|hey|start|restart|menu)\b[,!.\s]*$/i.test(text);
  const restart = /^(restart|start over|reset|menu)\b/i.test(text);
  const midTrip = hasTripProgress(s);

  // Never wipe persistent trip slots on a follow-up. Only reset on greeting/restart/done.
  if (restart || greetingOnly || s.step === "done" || (s.step === "idle" && !midTrip)) {
    if (restart || greetingOnly || s.step === "done") {
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
      await say(
        s,
        "Hey — I’m Manebra Travel.",
        "Tell me where you’re flying (e.g. JFK → Accra Friday) and I’ll find options, book, then show carry jobs you can earn on.",
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
    await reply(s, "Hey — I’m Manebra Travel. On it…", { thinkMs: 300 });
  }

  await handleTravelInbound(s, text, { reply, say });
}
