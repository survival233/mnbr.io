import type { ProductListing } from "@manebra/catalog";
import type { StayMemory } from "@manebra/dialog";
import { loadSessionsInto, schedulePersist, persistNow } from "./session-store.mts";
import { blankCognition, type CognitionState } from "./cognition/state.mts";

export type Step =
  | "idle"
  | "await_product"
  | "await_product_confirm"
  | "await_shopping_city"
  | "await_listing"
  | "await_delivery_city"
  | "await_deadline"
  | "await_max_fee"
  | "await_extend"
  | "await_traveler"
  | "await_brief_confirm"
  | "await_traveler_decision"
  | "await_pay_confirm"
  | "await_handover_done"
  | "done";

export type RankedTraveler = {
  id: string;
  name: string;
  score: number;
  departs: string;
};

export type Channel = "linq" | "relay";

/** Last value the agent offered. “yeah” / “that one” apply this — not the raw utterance. */
export type DialogOffer = {
  field: "shoppingCity" | "deliveryCity" | "deadline" | "maxFeeCents" | "listing" | "traveler" | "pay";
  value: string;
};

/** Open question the shopper must answer. Survives reconnect via session-store. */
export type PendingSlot = {
  slot: "product" | "shopping_city" | "delivery_city" | "need_by" | "delivery_fee" | "listing" | "traveler" | "pay" | "brief";
  proposed: string | number | null;
  kind: "date" | "choice" | "money" | "text" | "bool";
  prompt: string;
  options?: { id: string; label: string }[];
};

export type Session = {
  phone: string;
  chatId: string | null;
  channel: Channel;
  /** Last Relay event id — used to build Idempotency-Key for multi-bubble replies. */
  relayEventId?: string;
  relayReplySeq?: number;
  /** Inbound Relay message id (for reply_to / read). */
  relayMessageId?: string;
  step: Step;
  searchQuery?: string;
  shoppingCity?: string;
  deliveryCity?: string;
  deadline?: Date;
  maxFeeCents?: number;
  category?: string;
  listings?: ProductListing[];
  selected?: ProductListing;
  ranked?: RankedTraveler[];
  extendCandidate?: RankedTraveler;
  chosenTravelerId?: string;
  /** Travelers already offered this request (decline / timeout). Do not re-offer. */
  triedTravelerIds?: string[];
  /** Suggested slot shown in the last agent turn (dialog state, not chat log). */
  offer?: DialogOffer;
  /** Canonical open question. Prefer this over offer when resolving a turn. */
  pending?: PendingSlot | null;
  /** Last N user/assistant turns (DST context). Not a second form store. */
  turns?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Shared stay — last item, quote, counterparty, offer, wait, last ask. */
  stay?: StayMemory;
  bidId?: string;
  escrowId?: string;
  handoverCode?: string;
  fundTxHash?: string;
  totalCents?: number;
  /** Pay-sheet already texted after traveler accept (AgentCard). */
  paySheetSent?: boolean;
  paySheetAmountCents?: number;
  /** Multimodal cognition: persona, episodic memory, pending product confirm. */
  cognition?: CognitionState;
  updatedAt: number;
};

const byPhone = new Map<string, Session>();
/** Same Relay conversation keeps the same form + pending. */
const byChat = new Map<string, Session>();
let loaded = false;

/** Call once at process start before accepting webhooks. */
export function initSessionStore(): void {
  if (loaded) return;
  loaded = true;
  loadSessionsInto(byPhone);
  for (const s of byPhone.values()) {
    if (s.chatId) byChat.set(s.chatId, s);
  }
}

function touchPersist() {
  schedulePersist(byPhone);
}

export function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Stable map key: E.164 digits for Linq phones; raw usr_/relay ids for Relay. */
export function sessionKey(id: string): string {
  const t = id.trim();
  if (t.startsWith("usr_") || t.startsWith("relay:") || t.startsWith("cnv_") || t.startsWith("chat_")) return t;
  const d = digits(t);
  return d || t;
}

export function getOrCreateSession(
  phone: string,
  chatId: string | null,
  opts?: { channel?: Channel; relayEventId?: string; relayMessageId?: string },
): Session {
  if (!loaded) initSessionStore();
  const key = sessionKey(phone);
  let s = (chatId ? byChat.get(chatId) : undefined) ?? byPhone.get(key);
  if (!s) {
    s = {
      phone,
      chatId,
      channel: opts?.channel ?? "linq",
      step: "idle",
      pending: null,
      stay: { openedAt: Date.now() },
      updatedAt: Date.now(),
    };
    byPhone.set(key, s);
  } else {
    byPhone.set(key, s);
    if (s.phone !== phone) s.phone = phone;
  }
  if (chatId) {
    s.chatId = chatId;
    byChat.set(chatId, s);
  }
  if (opts?.channel) s.channel = opts.channel;
  if (opts?.relayEventId) {
    s.relayEventId = opts.relayEventId;
    s.relayReplySeq = 0;
  }
  if (opts?.relayMessageId) s.relayMessageId = opts.relayMessageId;
  // Backfill for sessions restored from disk before channel existed
  if (!(s as Session).channel) s.channel = "linq";
  s.updatedAt = Date.now();
  touchPersist();
  return s;
}

export function resetSession(s: Session) {
  s.step = "idle";
  s.searchQuery = undefined;
  s.shoppingCity = undefined;
  s.deliveryCity = undefined;
  s.deadline = undefined;
  s.maxFeeCents = undefined;
  s.category = undefined;
  s.listings = undefined;
  s.selected = undefined;
  s.ranked = undefined;
  s.extendCandidate = undefined;
  s.chosenTravelerId = undefined;
  s.triedTravelerIds = undefined;
  s.offer = undefined;
  s.pending = null;
  s.bidId = undefined;
  s.escrowId = undefined;
  s.handoverCode = undefined;
  s.fundTxHash = undefined;
  s.totalCents = undefined;
  s.paySheetSent = undefined;
  s.paySheetAmountCents = undefined;
  s.stay = { openedAt: Date.now() };
  // Keep long-horizon persona/memory; clear only in-flight confirm.
  if (s.cognition) {
    s.cognition.pending = null;
    s.cognition.topic = "intake";
  } else {
    s.cognition = blankCognition();
  }
  s.updatedAt = Date.now();
  touchPersist();
}

export function markSessionDirty() {
  touchPersist();
}

export function persistSessionsNow() {
  persistNow(byPhone);
}

export function appendDialogTurn(s: Session, role: "user" | "assistant", text: string): void {
  const line = text.trim().slice(0, 400);
  if (!line) return;
  s.turns = [...(s.turns ?? []), { role, text: line }].slice(-8);
  s.updatedAt = Date.now();
  touchPersist();
}

export function allSessions(): Session[] {
  return [...byPhone.values()];
}

export function sessionStats(): { count: number; lastActivityAt: number | null } {
  let last: number | null = null;
  for (const s of byPhone.values()) {
    if (last == null || s.updatedAt > last) last = s.updatedAt;
  }
  return { count: byPhone.size, lastActivityAt: last };
}

export { parseDate, parseUsdCents, categoryOf } from "@manebra/dialog";
