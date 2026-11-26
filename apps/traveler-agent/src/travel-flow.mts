/**
 * Travel-only flow for the Manebra traveler agent:
 * extract → merge trip state → missing_fields → ask or search → pick → book → earn.
 */
import {
  parseDepartDate,
  cityFromAirport,
  searchFlights,
  formatFlightOption,
  googleFlightsDeepLink,
  isoDate,
  type FlightOption,
} from "@manebra/flights";
import { normalizeCity } from "@manebra/calendar";
import { hubCity, sameMetro } from "@manebra/geo";
import { upsertLiveTrip, listFundedOffers, getTravelerCard } from "@manebra/db";
import { interpretReply, llmUnderstandingEnabled } from "@manebra/llm";
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

  if (s.step === "await_flight_origin") {
    return handleFlightOrigin(s, t, deps);
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
    return proceedAfterTrip(s, deps);
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

  let after = tripSnapshot(trip);
  // Understanding fallback: the rules didn't advance the trip on this reply, so
  // if a field is still open, let the model interpret an off-pattern answer.
  if (llmUnderstandingEnabled() && JSON.stringify(before) === JSON.stringify(after)) {
    if (await llmFillTripField(s, trip, text)) after = tripSnapshot(trip);
  }
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

  return proceedAfterTrip(s, deps);
}

async function askShopOptIn(s: Session, deps: { reply: ReplyFn; say: SayFn }): Promise<boolean> {
  s.step = "await_shop_opt_in";
  parkAsk(s, "shop_opt_in", TRAVELER_OPT_IN_ASK, null, "bool");
  await deps.reply(s, TRAVELER_OPT_IN_ASK);
  return true;
}

/**
 * Show live flight options for the trip's route + date and wait for a pick.
 * Search-only: the traveler books on the airline/OTA via a deep link (no in-app
 * ticketing yet — that's the DuffelFlightProvider seam). Returns true if shown;
 * false (missing origin or no results) so the caller moves on to the opt-in.
 */
async function presentFlights(s: Session, deps: { reply: ReplyFn; say: SayFn }): Promise<boolean> {
  const trip = ensureTrip(s);
  if (!trip.origin || !trip.destination || !trip.departure_date) return false;
  // The live search can take a few seconds — ack first so the date step never
  // looks dead while we wait.
  await deps.reply(s, `Checking flights ${trip.origin}→${trip.destination}…`);
  let options: FlightOption[] = [];
  try {
    options = await searchFlights({
      origin: trip.origin,
      destination: trip.destination,
      departDate: trip.departure_date,
      limit: 3,
    });
  } catch (e: any) {
    console.warn(`[traveler-agent] flight search failed: ${e?.message ?? e}`);
  }
  if (!options.length) {
    // No schedules (e.g. a date too far out) or a timeout: say so and let the
    // caller move on to the opt-in rather than stalling.
    await deps.reply(
      s,
      `I couldn’t find flights for ${trip.origin}→${trip.destination} on ${trip.departure_date} — that date may be too far out. I’ve saved your trip; try a date within ~11 months for live prices.`,
    );
    return false;
  }
  s.flightOptions = options;
  s.selectedFlight = undefined;
  s.step = "await_flight_pick";
  persistTrip(s);
  const list = options.map((o, i) => formatFlightOption(o, i)).join("\n");
  await deps.say(
    s,
    `Flights ${trip.origin}→${trip.destination} on ${trip.departure_date}:\n${list}\n\nReply with a number for a booking link, or “skip”.`,
  );
  return true;
}

async function continueToShopOptIn(s: Session, deps: { reply: ReplyFn; say: SayFn }): Promise<boolean> {
  const trip = ensureTrip(s);
  if (trip.optedIn === undefined) return askShopOptIn(s, deps);
  await afterTripCommitted(s, deps);
  return true;
}

/**
 * LLM understanding fallback: when the rule-based merge couldn't fill the open
 * trip field from an off-pattern reply, ask the model to interpret it. Returns
 * true if it set a field (caller re-evaluates). Flag-guarded; safe no-op when
 * disabled/unconfigured.
 */
async function llmFillTripField(s: Session, trip: ReturnType<typeof ensureTrip>, text: string): Promise<boolean> {
  const q = nextQuestion(trip);
  if (!q) return false;
  const res = await interpretReply({
    message: text,
    asked: q.text,
    slot: q.field,
    kind: q.field === "departure_date" ? "date" : "text",
    state: JSON.stringify(tripSnapshot(trip)),
  });
  if (!res || res.action !== "answer" || !res.value) return false;
  if (q.field === "departure_date") {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(res.value) ? res.value : parseDepartDate(res.value);
    if (!iso) return false;
    trip.departure_date = iso;
  } else if (q.field === "destination") {
    trip.destination = res.value;
  } else if (q.field === "origin") {
    trip.origin = res.value;
  } else {
    return false;
  }
  if (!trip.confirmed.includes(q.field)) trip.confirmed.push(q.field);
  persistTrip(s);
  return true;
}

const FLIGHT_ORIGIN_ASK = "Which city are you flying out from? (or say “skip”)";

/** Trip is complete: get origin if needed, offer flights, then the opt-in. */
async function proceedAfterTrip(s: Session, deps: { reply: ReplyFn; say: SayFn }): Promise<boolean> {
  const trip = ensureTrip(s);
  if (trip.destination && trip.departure_date && !trip.origin) {
    s.step = "await_flight_origin";
    parkAsk(s, "origin", FLIGHT_ORIGIN_ASK, null, "text");
    await deps.reply(s, FLIGHT_ORIGIN_ASK);
    return true;
  }
  if (await presentFlights(s, deps)) return true;
  return continueToShopOptIn(s, deps);
}

/** Capture the departure city, then show flights (or move on if skipped/empty). */
async function handleFlightOrigin(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const trip = ensureTrip(s);
  if (/^(n|no|nope|nah|skip|not now|don'?t)\b/i.test(text.trim())) {
    s.step = "await_travel_intent";
    persistTrip(s);
    return continueToShopOptIn(s, deps);
  }
  const city =
    extractSlots(text).origin ??
    text.replace(/^\s*(from|i'?m in|departing|flying (out )?(of|from))\s+/i, "").trim();
  if (!city) {
    await deps.reply(s, FLIGHT_ORIGIN_ASK);
    return true;
  }
  trip.origin = city;
  if (!trip.confirmed.includes("origin")) trip.confirmed.push("origin");
  s.step = "await_travel_intent";
  persistTrip(s);
  if (await presentFlights(s, deps)) return true;
  return continueToShopOptIn(s, deps);
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
  const options = s.flightOptions ?? [];
  if (!options.length) {
    s.flightOptions = undefined;
    return continueToShopOptIn(s, deps);
  }
  if (/^(n|no|nope|nah|skip|not now|none)\b/i.test(text.trim())) {
    s.flightOptions = undefined;
    persistTrip(s);
    await deps.reply(s, `No problem — I won’t pull a booking link.`);
    return continueToShopOptIn(s, deps);
  }
  const n = parseInt(text.trim(), 10);
  let idx = Number.isInteger(n) ? n - 1 : -1;
  if (!(idx >= 0 && idx < options.length)) {
    if (acceptsOffer(text)) idx = 0;
    else {
      await deps.reply(s, `Reply with a number 1–${options.length}, or “skip”.`);
      return true;
    }
  }
  const chosen = options[idx]!;
  s.selectedFlight = chosen;
  s.flightOptions = undefined;
  persistTrip(s);
  const url =
    chosen.bookingUrl ?? googleFlightsDeepLink(chosen.origin, chosen.destination, isoDate(chosen.departAt));
  await deps.say(
    s,
    `${chosen.airline}${chosen.flightNumber ? " " + chosen.flightNumber : ""} · ${chosen.origin}→${chosen.destination} · $${(chosen.priceCents / 100).toFixed(0)} — book it here:`,
    url,
  );
  return continueToShopOptIn(s, deps);
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
