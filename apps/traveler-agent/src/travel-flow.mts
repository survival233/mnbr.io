/**
 * Travel-only flow for the Manebra traveler agent:
 * extract → merge trip state → missing_fields → ask or search → pick → book → earn.
 */
import {
  parseDepartDate,
  cityFromAirport,
} from "@manebra/flights";
import { normalizeCity } from "@manebra/calendar";
import { hubCity, sameMetro } from "@manebra/geo";
import { upsertLiveTrip, listFundedOffers, getTravelerCard } from "@manebra/db";
import { fetchGoogleCalendarEvents } from "@manebra/calendar";
import { agentcardConfigured, createWalletLink } from "@repo/agentcard";
import type { Session } from "./session.mts";
import { sessionKey, markSessionDirty, persistSessionsNow } from "./session.mts";
import {
  persistBeforeAsk,
  composeHostReply,
  HOSPITALITY_PERSONA,
  TRAVELER_SLOT_SCHEMA,
  ensureStay,
  rememberQuestion,
  rememberItem,
  travelerAsk,
  travelerMarketplaceLine,
  TRAVELER_OPT_IN_ASK,
  TRAVELER_TRIP_SAVED,
  TRAVELER_OPTED_OUT,
  TRAVELER_WALLET_ADD,
  TRAVELER_CARD_ON_FILE,
  TRAVELER_FLIGHT_STUB,
  TRAVELER_HI,
  asksToBookFlight,
  asksForFreshWallet,
  CALENDAR_CONNECT_HEADLINE,
  CALENDAR_CONNECT_PRIMARY,
  CALENDAR_CONNECT_LATER,
  CALENDAR_PRIVACY,
  CALENDAR_CONNECTED,
  CALENDAR_NONE,
  CALENDAR_OAUTH_FAILED,
  CALENDAR_GMAIL_STUB,
  CALENDAR_APPLE_STUB,
  CALENDAR_UNCONFIGURED,
  CALENDAR_ALREADY,
  CALENDAR_DISCONNECTED,
  calendarTripProposal,
  wantsCalendarConnect,
  wantsGmailConnect,
  wantsPhoneCalendar,
  dismissesCalendarSetup,
  choosesWhereHeaded,
  type DialogPendingSlot,
} from "@manebra/dialog";
import { acceptEarnOffer, type EarnOffer } from "./traveler-bridge.mts";
import {
  ensureTrip,
  mergeTripState,
  missingFields,
  nextQuestion,
  tripSnapshot,
  mirrorTripToLegacy,
  extractSlots,
} from "./trip-state.mts";
import {
  accessTokenFor,
  calendarConnectStart,
  calendarConnectStatus,
  calendarDisconnect,
  chooseCalendarTrip,
  formatTripWhen,
  getCalendarStore,
  proposeConfirmedFlights,
  type CalendarTripRecord,
} from "./calendar-connect.mts";

type ReplyFn = (s: Session, text: string, opts?: { thinkMs?: number }) => Promise<void>;
type SayFn = (s: Session, ...bubbles: string[]) => Promise<void>;

void TRAVELER_SLOT_SCHEMA;
void HOSPITALITY_PERSONA;

function stayOf(s: Session) {
  s.stay = ensureStay(s.stay);
  return s.stay;
}

function persistTrip(s: Session) {
  mirrorTripToLegacy(s);
  markSessionDirty();
  persistBeforeAsk(persistSessionsNow);
}

function parkAsk(s: Session, slot: DialogPendingSlot["slot"], prompt: string, proposed: string | number | null, kind: DialogPendingSlot["kind"]) {
  s.pending = { slot, proposed, kind, prompt };
  rememberQuestion(stayOf(s), prompt);
  persistTrip(s);
}

function tripCity(raw?: string): string | null {
  if (!raw) return null;
  return (
    hubCity(raw) ??
    hubCity(cityFromAirport(raw)) ??
    normalizeCity(raw) ??
    normalizeCity(cityFromAirport(raw)) ??
    (raw.trim() || null)
  );
}

function tripDate(raw?: string): Date {
  const iso =
    raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : raw
        ? parseDepartDate(raw)
        : null;
  if (iso) return new Date(`${iso}T12:00:00`);
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(12, 0, 0, 0);
  return d;
}

async function publishLiveTrip(s: Session, optedIn: boolean): Promise<void> {
  const trip = s.trip;
  if (!trip?.destination || !trip.departure_date) return;
  const dest = tripCity(trip.destination);
  if (!dest) return;
  try {
    if (trip.externalEventId && trip.source === "calendar") {
      await chooseCalendarTrip({
        travelerId: sessionKey(s.phone),
        externalEventId: trip.externalEventId,
        optedIn,
      });
      return;
    }
    await upsertLiveTrip({
      travelerId: sessionKey(s.phone),
      travelerName: `Traveler ${sessionKey(s.phone).slice(-4)}`,
      originCity: tripCity(trip.origin) ?? "",
      destinationCity: dest,
      departureDate: tripDate(trip.departure_date),
      optedIn,
    });
  } catch (e: any) {
    console.warn(`[traveler-agent] marketplace trip upsert skipped: ${e?.message ?? e}`);
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function loadProposal(s: Session, trip: CalendarTripRecord): void {
  const slot = ensureTrip(s);
  slot.destination = trip.destinationCity;
  slot.departure_date = isoDay(trip.departureDate);
  if (trip.originCity && trip.originCity !== "Unknown") slot.origin = trip.originCity;
  slot.externalEventId = trip.externalEventId;
  slot.source = "calendar";
  slot.timezone = trip.timezone;
  slot.departAt = trip.departAt.toISOString();
  slot.optedIn = undefined;
  if (!slot.confirmed.includes("destination")) slot.confirmed.push("destination");
  if (!slot.confirmed.includes("departure_date")) slot.confirmed.push("departure_date");
  mirrorTripToLegacy(s);
}

async function askProposal(s: Session, trip: CalendarTripRecord, deps: { reply: ReplyFn; say: SayFn }): Promise<void> {
  loadProposal(s, trip);
  s.step = "await_shop_opt_in";
  const when = formatTripWhen(trip.departAt, trip.timezone);
  parkAsk(s, "shop_opt_in", TRAVELER_OPT_IN_ASK, null, "bool");
  await deps.say(s, calendarTripProposal(trip.destinationCity, when), TRAVELER_OPT_IN_ASK);
}

async function speakProposals(
  s: Session,
  proposed: CalendarTripRecord[],
  deps: { reply: ReplyFn; say: SayFn },
): Promise<void> {
  const open = proposed
    .filter((t) => t.status === "proposed" && !t.optedIn)
    .sort((a, b) => a.departAt.getTime() - b.departAt.getTime());
  if (!open.length) {
    s.step = "await_travel_intent";
    s.calendarQueue = [];
    persistTrip(s);
    await deps.say(s, CALENDAR_NONE);
    return;
  }
  const [first, ...rest] = open;
  s.calendarQueue = rest.map((t) => t.externalEventId);
  if (!first) return;
  await askProposal(s, first, deps);
}

async function syncConnectedCalendar(s: Session, deps: { reply: ReplyFn; say: SayFn }): Promise<void> {
  const id = sessionKey(s.phone);
  s.calendarSynced = true;
  const token = await accessTokenFor(id);
  if (!token) {
    s.step = "await_calendar_choice";
    persistTrip(s);
    await deps.say(s, CALENDAR_OAUTH_FAILED, CALENDAR_CONNECT_LATER);
    return;
  }
  let events: Awaited<ReturnType<typeof fetchGoogleCalendarEvents>> = [];
  try {
    events = await fetchGoogleCalendarEvents({ accessToken: token, calendarIds: "all" });
  } catch (e: any) {
    console.warn(`[traveler-agent] calendar sync skipped: ${e?.message ?? e}`);
  }
  const proposed = await proposeConfirmedFlights({
    travelerId: id,
    travelerName: `Traveler ${id.slice(-4)}`,
    events,
  });
  await speakProposals(s, proposed, deps);
}

export async function presentCalendarConnect(
  s: Session,
  deps: { reply: ReplyFn; say: SayFn },
  opts?: { provider?: "google" | "apple" },
): Promise<void> {
  const id = sessionKey(s.phone);
  if (opts?.provider === "apple") {
    s.step = "await_calendar_choice";
    persistTrip(s);
    await deps.say(s, CALENDAR_APPLE_STUB, CALENDAR_CONNECT_LATER, CALENDAR_PRIVACY);
    return;
  }
  const status = await calendarConnectStatus(id);
  if (status.connected) {
    await deps.say(s, CALENDAR_ALREADY);
    await syncConnectedCalendar(s, deps);
    return;
  }
  const start = await calendarConnectStart({
    travelerId: id,
    chatId: s.chatId,
    channel: s.channel,
    provider: "google",
  });
  s.step = "await_calendar_choice";
  persistTrip(s);
  const bubbles = [CALENDAR_CONNECT_HEADLINE, CALENDAR_CONNECT_PRIMARY];
  if (start.ok) bubbles.push(start.connectUrl);
  else bubbles.push(CALENDAR_UNCONFIGURED);
  bubbles.push(CALENDAR_CONNECT_LATER, CALENDAR_PRIVACY);
  await deps.say(s, ...bubbles);
}

export async function maybeHandleCalendar(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  if (/\bdisconnect calendar\b/i.test(text)) {
    const result = await calendarDisconnect(sessionKey(s.phone));
    s.calendarSynced = false;
    persistTrip(s);
    await deps.say(s, CALENDAR_DISCONNECTED);
    void result;
    return true;
  }
  if (wantsGmailConnect(text)) {
    await deps.say(s, CALENDAR_GMAIL_STUB);
    return true;
  }
  if (wantsPhoneCalendar(text) && !/\blink google\b/i.test(text)) {
    await presentCalendarConnect(s, deps, { provider: "apple" });
    return true;
  }
  if (wantsCalendarConnect(text)) {
    await presentCalendarConnect(s, deps);
    return true;
  }
  if (s.step === "await_calendar_choice") {
    if (dismissesCalendarSetup(text) || choosesWhereHeaded(text)) {
      s.calendarDismissed = true;
      s.step = "await_travel_intent";
      persistTrip(s);
      await deps.say(s, TRAVELER_HI);
      return true;
    }
    if (/^(y|yes|ok|okay|connect)\b/i.test(text.trim())) {
      await presentCalendarConnect(s, deps);
      return true;
    }
  }
  return false;
}

export async function deliverCalendarOAuth(
  result:
    | { ok: true; travelerId: string; chatId: string | null; channel: "relay" | "linq"; proposed: CalendarTripRecord[] }
    | { ok: false; reason: string; travelerId?: string; chatId?: string | null; channel?: "relay" | "linq" },
  deps: { reply: ReplyFn; say: SayFn },
): Promise<void> {
  const travelerId = result.travelerId;
  if (!travelerId) return;
  const { getOrCreateSession } = await import("./session.mts");
  const s = getOrCreateSession(travelerId, result.chatId ?? null, {
    channel: result.channel ?? "relay",
  });
  s.calendarSynced = true;
  if (!result.ok) {
    s.step = "await_calendar_choice";
    persistTrip(s);
    await deps.say(s, CALENDAR_OAUTH_FAILED, CALENDAR_CONNECT_LATER);
    return;
  }
  await deps.say(s, CALENDAR_CONNECTED);
  await speakProposals(s, result.proposed, deps);
}

async function needsCalendarOffer(s: Session, text: string): Promise<boolean> {
  const trip = ensureTrip(s);
  if (trip.destination || s.calendarDismissed || s.step === "await_calendar_choice") return false;
  if (asksToBookFlight(text) || choosesWhereHeaded(text)) return false;
  const extracted = extractSlots(text);
  if (extracted.destination || extracted.departure_date || extracted.origin) return false;
  const status = await calendarConnectStatus(sessionKey(s.phone));
  if (status.connected) return !s.calendarSynced;
  return true;
}

async function matchingFundedAsk(s: Session) {
  const dest = tripCity(s.trip?.destination);
  if (!dest) return null;
  try {
    const funded = await listFundedOffers();
    return funded.find((o) => {
      if (!o.destinationCity || !sameMetro(o.destinationCity, dest)) return false;
      const owner = o.travelerId?.trim();
      return !owner || owner === sessionKey(s.phone);
    }) ?? null;
  } catch {
    return null;
  }
}

export async function sendTravelerWallet(s: Session, deps: { say: SayFn }): Promise<boolean> {
  if (!agentcardConfigured()) return false;
  const id = sessionKey(s.phone);
  const onFile = await getTravelerCard(id);
  if (onFile) return false;
  try {
    const link = await createWalletLink(id);
    s.step = "await_traveler_card";
    parkAsk(s, "traveler_card", TRAVELER_WALLET_ADD, null, "bool");
    await deps.say(s, TRAVELER_WALLET_ADD, link.url);
    return true;
  } catch (e: any) {
    console.warn(`[traveler-agent] wallet link: ${e?.message ?? e}`);
    return false;
  }
}

async function afterTripCommitted(s: Session, deps: { reply: ReplyFn; say: SayFn }): Promise<void> {
  if (await sendTravelerWallet(s, deps)) return;
  await maybePingFundedAsk(s, deps);
}

async function maybePingFundedAsk(s: Session, deps: { reply: ReplyFn; say: SayFn }): Promise<void> {
  if (stayOf(s).lastOfferId) {
    s.step = "trip_confirmed";
    persistTrip(s);
    return;
  }
  const dest = tripCity(s.trip?.destination) ?? s.trip?.destination ?? "your city";
  if (s.trip?.optedIn) {
    const match = await matchingFundedAsk(s);
    if (match) {
      await deps.say(
        s,
        travelerMarketplaceLine({
          earningsCents: match.travelerFeeCents || 0,
          title: match.item,
          metro: dest,
        }),
        ...travelerAsk({
          city: dest,
          title: match.item,
          merchant: match.nextTravelerName?.trim() || "the store",
          itemCents: match.itemCostCents ?? 0,
          earningsCents: match.travelerFeeCents || 0,
        }),
      );
      s.step = "await_earn_opt_in";
      persistTrip(s);
      return;
    }
  }
  await deps.reply(s, TRAVELER_TRIP_SAVED);
  s.step = "trip_confirmed";
  persistTrip(s);
}

/** Webhook stamped a card while the traveler was waiting on the wallet link. */
export async function resumeAfterTravelerCard(
  s: Session,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<void> {
  await deps.reply(s, TRAVELER_CARD_ON_FILE);
  await maybePingFundedAsk(s, deps);
}

export async function handleTravelInbound(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const t = text.trim();

  if (s.step === "await_traveler_card") {
    return handleTravelerCard(s, t, deps);
  }

  if (s.step === "await_shop_opt_in") {
    return handleShopOptIn(s, t, deps);
  }

  if (s.step === "await_earn_opt_in" || s.step === "await_job_pick") {
    return handleEarn(s, t, deps);
  }

  if (s.step === "await_flight_pick" || s.step === "await_book_confirm") {
    return handlePickOrBook(s, t, deps);
  }

  return handleCollectAndSearch(s, t, deps);
}

const ACCEPT_OFFER_RE =
  /^(y|yes|ok|okay|sure|yeah|yep|yup|idk|whatever|you pick|up to you|sounds good|that works|that one|the first|first one)\b/i;

function acceptsOffer(text: string): boolean {
  return ACCEPT_OFFER_RE.test(text.trim());
}

async function handleCollectAndSearch(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const { reply, say } = deps;
  const trip = ensureTrip(s);
  if (await needsCalendarOffer(s, text)) {
    const status = await calendarConnectStatus(sessionKey(s.phone));
    if (status.connected && !s.calendarSynced) {
      await syncConnectedCalendar(s, deps);
      return true;
    }
    await presentCalendarConnect(s, deps);
    return true;
  }
  const before = tripSnapshot(trip);

  if (asksToBookFlight(text)) {
    await reply(s, TRAVELER_FLIGHT_STUB);
    const missingFlight = missingFields(trip);
    if (missingFlight.length) {
      const ask = nextQuestion(trip);
      if (ask) {
        parkAsk(
          s,
          ask.field,
          ask.text,
          null,
          ask.field === "departure_date" ? "date" : "text",
        );
        await reply(s, ask.text);
      }
      return true;
    }
    if (trip.optedIn === undefined) {
      return askShopOptIn(s, deps);
    }
    await afterTripCommitted(s, deps);
    return true;
  }

  if (acceptsOffer(text) && s.offer && s.offer.field !== "flight") {
    if (s.offer.field === "origin") trip.origin = s.offer.value;
    else if (s.offer.field === "destination") trip.destination = s.offer.value;
    else if (s.offer.field === "departure_date") trip.departure_date = s.offer.value;
    if (!trip.confirmed.includes(s.offer.field)) trip.confirmed.push(s.offer.field);
    s.offer = undefined;
  } else {
    const rest = text.replace(/^(n|no|nope|nah)[,.\s]+/i, "").trim();
    mergeTripState(trip, rest || text);
  }
  mirrorTripToLegacy(s);
  s.step = "await_travel_intent";
  persistTrip(s);

  const after = tripSnapshot(trip);
  const missing = missingFields(trip);
  console.log(
    `[traveler-agent] trip ${JSON.stringify(before)} + ${JSON.stringify(text.slice(0, 80))} → ${JSON.stringify(after)} missing=${JSON.stringify(missing)}`,
  );

  const ask = nextQuestion(trip);
  if (ask) {
    if (ask.field === "departure_date") {
      s.offer = undefined;
    }
    const dest = trip.destination;
    if (dest) rememberItem(stayOf(s), dest);
    parkAsk(
      s,
      ask.field,
      ask.text,
      s.offer?.field === ask.field ? s.offer.value : null,
      ask.field === "departure_date" ? "date" : "text",
    );
    const beats = composeHostReply({
      act: stayOf(s).lastAct ?? "CONTINUE",
      stay: stayOf(s),
      next: ask.text,
    });
    if (beats.length > 1) await say(s, ...beats);
    else await reply(s, beats[0] ?? ask.text);
    return true;
  }

  if (trip.optedIn === undefined) {
    return askShopOptIn(s, deps);
  }

  await afterTripCommitted(s, deps);
  return true;
}

async function askShopOptIn(s: Session, deps: { reply: ReplyFn; say: SayFn }): Promise<boolean> {
  s.step = "await_shop_opt_in";
  parkAsk(s, "shop_opt_in", TRAVELER_OPT_IN_ASK, null, "bool");
  await deps.reply(s, TRAVELER_OPT_IN_ASK);
  return true;
}

function yesNo(text: string): boolean | null {
  const t = text.trim();
  if (/^(n|no|nope|nah|skip|not now|later)\b/i.test(t)) return false;
  if (/^(y|yes|ok|okay|sure|yeah|yep|yup)\b/i.test(t)) return true;
  return null;
}

async function handleShopOptIn(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const trip = ensureTrip(s);
  const answer = yesNo(text);
  if (answer == null) {
    parkAsk(s, "shop_opt_in", TRAVELER_OPT_IN_ASK, null, "bool");
    await deps.reply(s, TRAVELER_OPT_IN_ASK);
    return true;
  }
  trip.optedIn = answer;
  trip.optedInAt = Date.now();
  persistTrip(s);
  await publishLiveTrip(s, answer);
  const queue = s.calendarQueue ?? [];
  if (queue.length) {
    const nextId = queue.shift();
    s.calendarQueue = queue;
    const rows = await getCalendarStore().listTrips(sessionKey(s.phone));
    const next = rows.find((t) => t.externalEventId === nextId && t.status === "proposed");
    if (next) {
      await askProposal(s, next, deps);
      return true;
    }
  }
  if (!answer) {
    await deps.reply(s, TRAVELER_OPTED_OUT);
    if (await sendTravelerWallet(s, deps)) return true;
    s.step = "trip_confirmed";
    persistTrip(s);
    return true;
  }
  await afterTripCommitted(s, deps);
  return true;
}

async function handleTravelerCard(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const id = sessionKey(s.phone);
  if (asksForFreshWallet(text)) {
    const sent = await sendTravelerWallet(s, deps);
    if (sent) return true;
  }
  const onFile = await getTravelerCard(id);
  if (onFile) {
    await deps.reply(s, TRAVELER_CARD_ON_FILE);
    await maybePingFundedAsk(s, deps);
    return true;
  }
  const skip = yesNo(text) === false;
  if (skip) {
    await maybePingFundedAsk(s, deps);
    return true;
  }
  await deps.reply(s, TRAVELER_WALLET_ADD);
  return true;
}

async function handlePickOrBook(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  void text;
  await deps.reply(s, TRAVELER_FLIGHT_STUB);
  const trip = ensureTrip(s);
  const ask = nextQuestion(trip);
  if (ask) {
    s.step = "await_travel_intent";
    parkAsk(
      s,
      ask.field,
      ask.text,
      null,
      ask.field === "departure_date" ? "date" : "text",
    );
    await deps.reply(s, ask.text);
    return true;
  }
  if (trip.optedIn === undefined) return askShopOptIn(s, deps);
  await afterTripCommitted(s, deps);
  return true;
}

async function handleEarn(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const { reply, say } = deps;
  const offers = s.earnOffers ?? [];
  const no = /^(n|no|nope|nah|skip|not now)\b/i.test(text);
  if (no) {
    s.step = "done";
    persistTrip(s);
    await reply(s, `All good — trip stays on file. Ping me if you want a request later.`);
    return true;
  }

  let offer: EarnOffer | undefined = offers[0];
  const n = parseInt(text, 10);
  if (n >= 1 && n <= offers.length) offer = offers[n - 1];
  if (!offer && !/^(y|yes|ok|okay|sure|yeah|yep|accept)\b/i.test(text)) {
    await reply(s, `Want it? Yes or no.`);
    return true;
  }
  if (!offer) {
    await reply(s, `Nothing to accept right now.`);
    return true;
  }

  const res = await acceptEarnOffer({ identity: s.phone, proposalId: offer.proposalId });
  s.step = "done";
  persistTrip(s);
  await say(s, res.message);
  return true;
}
