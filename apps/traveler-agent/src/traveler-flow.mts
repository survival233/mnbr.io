import * as relay from "./relay-client.mts";
import {
  getOrCreateSession,
  resetSession,
  markSessionDirty,
  type Session,
} from "./session.mts";
import { handleTravelInbound } from "./travel-flow.mts";

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
  console.log(`[traveler-agent] → ${s.phone}: ${text.slice(0, 80).replace(/\n/g, " ")}`);
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

export async function handleInbound(args: {
  phone: string;
  chatId: string | null;
  text: string;
  relayEventId?: string;
  relayMessageId?: string;
}): Promise<void> {
  const text = (args.text ?? "").trim();
  const s = getOrCreateSession(args.phone, args.chatId, {
    relayEventId: args.relayEventId,
    relayMessageId: args.relayMessageId,
  });

  const greetingOnly = /^(hi|hello|hey|start|restart|menu)\b[,!.\s]*$/i.test(text);
  const restart = /^(restart|start over|reset|menu)\b/i.test(text);

  if (restart || s.step === "idle" || s.step === "done" || greetingOnly) {
    if (restart || greetingOnly || s.step === "idle" || s.step === "done") {
      resetSession(s);
      s.step = "await_travel_intent";
      markSessionDirty();
      await say(
        s,
        "Hey — I’m Manebra Travel.",
        "Tell me where you’re flying (e.g. JFK → Accra Friday) and I’ll find options, book, then show carry jobs you can earn on.",
      );
      if (greetingOnly || restart) {
        const rest = text.replace(/^(hi|hello|hey|start|restart|menu|start over|reset)\b[,!.\s]*/i, "").trim();
        if (!rest) return;
        await handleTravelInbound(s, rest, { reply, say });
        return;
      }
      if (!text) return;
    }
  }

  await handleTravelInbound(s, text, { reply, say });
}
