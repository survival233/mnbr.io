import type { FlightOption } from "@manebra/flights";
import type { EarnOffer } from "./traveler-bridge.mts";
import { loadSessionsInto, schedulePersist, persistNow } from "./session-store.mts";

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
let loaded = false;

export function initSessionStore(): void {
  if (loaded) return;
  loaded = true;
  loadSessionsInto(byPhone);
}

function touchPersist() {
  schedulePersist(byPhone);
}

export function sessionKey(id: string): string {
  const t = id.trim();
  if (t.startsWith("usr_") || t.startsWith("relay:") || t.startsWith("cnv_")) return t;
  return t.replace(/\D/g, "") || t;
}

export function getOrCreateSession(
  phone: string,
  chatId: string | null,
  opts?: { channel?: Channel; relayEventId?: string; relayMessageId?: string },
): Session {
  if (!loaded) initSessionStore();
  const key = sessionKey(phone);
  let s = byPhone.get(key);
  if (!s) {
    s = {
      phone,
      chatId,
      channel: opts?.channel ?? "linq",
      step: "idle",
      updatedAt: Date.now(),
    };
    byPhone.set(key, s);
  }
  if (chatId) s.chatId = chatId;
  if (opts?.channel) s.channel = opts.channel;
  if (opts?.relayEventId) {
    s.relayEventId = opts.relayEventId;
    s.relayReplySeq = 0;
  }
  if (opts?.relayMessageId) s.relayMessageId = opts.relayMessageId;
  if (!(s as Session).channel) s.channel = "linq";
  s.updatedAt = Date.now();
  touchPersist();
  return s;
}

export function resetSession(s: Session) {
  s.step = "idle";
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
