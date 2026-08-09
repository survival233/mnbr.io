import type { FlightOption } from "@manebra/flights";
import type { EarnOffer } from "./traveler-bridge.mts";
import { loadSessionsInto, schedulePersist, persistNow } from "./session-store.mts";
import { blankTrip, ensureTrip, type TripState } from "./trip-state.mts";

export type Step =
  | "idle"
  | "await_travel_intent"
  | "await_flight_pick"
  | "await_book_confirm"
  | "trip_confirmed"
  | "await_earn_opt_in"
  | "await_job_pick"
  | "done";

export type Channel = "linq" | "relay";

export type Session = {
  phone: string;
  chatId: string | null;
  channel: Channel;
  relayEventId?: string;
  relayReplySeq?: number;
  relayMessageId?: string;
  step: Step;
  /** Canonical persistent trip slots (origin / destination / departure_date). */
  trip?: TripState;
  /** Legacy mirrors — kept in sync with trip. */
  travelOrigin?: string;
  travelDestination?: string;
  travelDepartDate?: string;
  travelArriveBy?: Date;
  flightOptions?: FlightOption[];
  selectedFlight?: FlightOption;
  flightBookingRef?: string;
  earnOffers?: EarnOffer[];
  updatedAt: number;
};

const byPhone = new Map<string, Session>();
/** Secondary index: Relay conversation / Linq chat id → same session. */
const byChat = new Map<string, Session>();
let loaded = false;

export function initSessionStore(): void {
  if (loaded) return;
  loaded = true;
  loadSessionsInto(byPhone);
  for (const s of byPhone.values()) {
    ensureTrip(s);
    if (s.chatId) byChat.set(s.chatId, s);
  }
}

function touchPersist() {
  schedulePersist(byPhone);
}

export function sessionKey(id: string): string {
  const t = id.trim();
  if (t.startsWith("usr_") || t.startsWith("relay:") || t.startsWith("cnv_") || t.startsWith("chat_"))
    return t;
  return t.replace(/\D/g, "") || t;
}

export function getOrCreateSession(
  phone: string,
  chatId: string | null,
  opts?: { channel?: Channel; relayEventId?: string; relayMessageId?: string },
): Session {
  if (!loaded) initSessionStore();
  const key = sessionKey(phone);

  // Prefer conversation continuity: same Relay chat keeps the same trip state.
  let s = (chatId ? byChat.get(chatId) : undefined) ?? byPhone.get(key);

  if (!s) {
    s = {
      phone,
      chatId,
      channel: opts?.channel ?? "linq",
      step: "idle",
      trip: blankTrip(),
      updatedAt: Date.now(),
    };
    byPhone.set(key, s);
  } else {
    // Keep both indexes pointing at the same object.
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
  if (!(s as Session).channel) s.channel = "linq";
  ensureTrip(s);
  s.updatedAt = Date.now();
  touchPersist();
  return s;
}

export function resetSession(s: Session) {
  s.step = "idle";
  s.trip = blankTrip();
  s.travelOrigin = undefined;
  s.travelDestination = undefined;
  s.travelDepartDate = undefined;
  s.travelArriveBy = undefined;
  s.flightOptions = undefined;
  s.selectedFlight = undefined;
  s.flightBookingRef = undefined;
  s.earnOffers = undefined;
  s.updatedAt = Date.now();
  touchPersist();
}

export function markSessionDirty() {
  touchPersist();
}

export function persistSessionsNow() {
  persistNow(byPhone);
}

export function sessionStats(): { count: number; lastActivityAt: number | null } {
  let last: number | null = null;
  for (const s of byPhone.values()) {
    if (last == null || s.updatedAt > last) last = s.updatedAt;
  }
  return { count: byPhone.size, lastActivityAt: last };
}

export function hasTripProgress(s: Session): boolean {
  const t = ensureTrip(s);
  return Boolean(t.origin || t.destination || t.departure_date);
}
