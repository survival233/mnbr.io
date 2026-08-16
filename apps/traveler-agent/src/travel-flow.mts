/**
 * Travel-only flow for the Manebra traveler agent:
 * extract → merge trip state → missing_fields → ask or search → pick → book → earn.
 */
import {
  searchFlights,
  bookFlight,
  formatFlightOption,
  parseDepartDate,
  cityFromAirport,
  type FlightOption,
} from "@manebra/flights";
import { normalizeCity } from "@manebra/calendar";
import { upsertLiveTrip } from "@manebra/db";
import type { Session } from "./session.mts";
import {
  persistBeforeAsk,
  composeHostReply,
  HOSPITALITY_PERSONA,
  TRAVELER_SLOT_SCHEMA,
  ensureStay,
  rememberQuestion,
  rememberItem,
  type DialogPendingSlot,
} from "@manebra/dialog";
import { markSessionDirty, persistSessionsNow } from "./session.mts";
import { persistBookedTrip, acceptEarnOffer, type EarnOffer } from "./traveler-bridge.mts";
import {
  ensureTrip,
  mergeTripState,
  missingFields,
  nextQuestion,
  isTripComplete,
  tripSnapshot,
  mirrorTripToLegacy,
  blankTrip,
} from "./trip-state.mts";

type ReplyFn = (s: Session, text: string, opts?: { thinkMs?: number }) => Promise<void>;
type SayFn = (s: Session, ...bubbles: string[]) => Promise<void>;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  return normalizeCity(raw) ?? normalizeCity(cityFromAirport(raw)) ?? (raw.trim() || null);
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

async function publishLiveTrip(s: Session): Promise<void> {
  const trip = s.trip;
  if (!trip?.destination) return;
  const dest = tripCity(trip.destination);
  if (!dest) return;
  try {
    await upsertLiveTrip({
      travelerId: s.phone,
      travelerName: `Traveler ${s.phone.slice(-4)}`,
      originCity: tripCity(trip.origin) ?? "",
      destinationCity: dest,
      departureDate: tripDate(trip.departure_date),
      optedIn: true,
    });
  } catch (e: any) {
    console.warn(`[traveler-agent] marketplace trip upsert skipped: ${e?.message ?? e}`);
  }
}

export async function handleTravelInbound(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const t = text.trim();

  if (s.step === "await_earn_opt_in" || s.step === "await_job_pick") {
    return handleEarn(s, t, deps);
  }

  if (s.step === "await_flight_pick" || s.step === "await_book_confirm") {
    return handlePickOrBook(s, t, deps);
  }

  if (s.step === "trip_confirmed" || s.step === "done") {
    // New trip request after completion — keep history cleared via caller reset, or soft-reset trip.
    if (!s.trip || isTripComplete(s.trip)) {
      s.trip = blankTrip();
    }
    s.step = "await_travel_intent";
    persistTrip(s);
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
  const before = tripSnapshot(trip);

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
  void publishLiveTrip(s);

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

  // All required slots present → search.
  await reply(s, `Searching ${trip.origin} → ${trip.destination} on ${trip.departure_date}…`, {
    thinkMs: 500,
  });

  try {
    const options = await searchFlights({
      origin: trip.origin!,
      destination: trip.destination!,
      departDate: trip.departure_date!,
      arriveBy: trip.arrive_by ? new Date(trip.arrive_by) : undefined,
      limit: 3,
    });
    if (!options.length) {
      await reply(s, `No flights found for that route/date. Try another day or airports?`);
      return true;
    }
    s.flightOptions = options;
    s.step = "await_flight_pick";
    s.offer = { field: "flight", value: "0" };
    parkAsk(s, "flight", `Reply with 1–${options.length}, or name a departure.`, "0", "choice");
    const lines = options.map((o, i) => formatFlightOption(o, i)).join("\n\n");
    await say(
      s,
      `Here are solid options:`,
      `${lines}\n\nReply with 1–${options.length}, or say something like “book the 8:30 PM”.`,
    );
  } catch (e: any) {
    console.warn(`[traveler-agent] search failed: ${e?.message ?? e}`);
    await reply(s, `Flight search hiccupped — try again in a moment, or tweak the airports/date.`);
  }
  return true;
}

async function handlePickOrBook(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const { reply, say } = deps;
  const options = s.flightOptions ?? [];
  if (!options.length) {
    s.step = "await_travel_intent";
    persistTrip(s);
    await reply(s, `Let’s start over — where and when do you want to fly?`);
    return true;
  }

  let idx = pickIndex(text, options);
  if (idx == null && acceptsOffer(text)) {
    idx = s.offer?.field === "flight" ? parseInt(s.offer.value, 10) : 0;
    if (!Number.isFinite(idx) || idx < 0 || idx >= options.length) idx = 0;
  }
  if (idx == null) {
    await reply(
      s,
      `Pick 1–${options.length}, or describe the time (e.g. “book the 8:30 PM”).`,
    );
    return true;
  }

  const offer = options[idx]!;
  s.selectedFlight = offer;
  s.step = "await_book_confirm";
  persistTrip(s);

  await reply(s, `Booking ${offer.airline} ${offer.flightNumber ?? ""}…`, { thinkMs: 600 });

  const paymentMethodId = process.env.FLIGHT_PAYMENT_METHOD_ID?.trim() || null;
  try {
    const booking = await bookFlight(
      {
        offerId: offer.offerId,
        passengerName: s.phone.slice(-4) ? `Traveler ${s.phone.slice(-4)}` : "Manebra Traveler",
        paymentMethodId,
        allowDemo: true,
      },
      offer,
    );

    if (booking.status === "pending_payment") {
      await say(
        s,
        booking.message,
        `Once payment is linked on your account, say “book it” again and I’ll ticket this fare.`,
      );
      return true;
    }

    s.flightBookingRef = booking.bookingRef;
    s.step = "trip_confirmed";
    persistTrip(s);
    void publishLiveTrip(s);
    await say(s, booking.message, `I’ll watch for the confirmation and keep this trip on file.`);

    const { earnOffers } = await persistBookedTrip({ identity: s.phone, booking });
    s.earnOffers = earnOffers;
    if (earnOffers.length) {
      s.step = "await_earn_opt_in";
      persistTrip(s);
      await sleep(400);
      const top = earnOffers[0]!;
      await say(
        s,
        `You’re headed to ${top.destinationCity}. A shopper needs ${top.itemName}. Traveler earnings about $${(top.feeCents / 100).toFixed(0)}.`,
        `Shop & Deliver — accept or decline?`,
      );
    } else {
      s.step = "done";
      persistTrip(s);
      await reply(
        s,
        `No open Shop & Deliver requests on that route yet — I’ll ping you if one shows up. Say hi anytime to search another flight.`,
      );
    }
  } catch (e: any) {
    console.warn(`[traveler-agent] book failed: ${e?.message ?? e}`);
    await reply(s, `Couldn’t complete booking — ${e?.message ?? "try again"}.`);
  }
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
    await reply(s, `Say yes to accept this Shop & Deliver, or no to skip.`);
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

function pickIndex(text: string, options: FlightOption[]): number | null {
  const bare = text.trim().match(/^(\d+)\.?$/);
  if (bare) {
    const i = parseInt(bare[1]!, 10) - 1;
    if (i >= 0 && i < options.length) return i;
  }
  const time = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (time) {
    let h = parseInt(time[1]!, 10);
    const m = parseInt(time[2]!, 10);
    const ap = time[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    for (let i = 0; i < options.length; i++) {
      const d = options[i]!.departAt;
      if (d.getHours() === h && d.getMinutes() === m) return i;
    }
    for (let i = 0; i < options.length; i++) {
      if (options[i]!.departAt.getHours() === h) return i;
    }
  }
  if (/\b(first|1st)\b/i.test(text)) return 0;
  if (/\b(second|2nd)\b/i.test(text) && options.length > 1) return 1;
  if (/\b(third|3rd)\b/i.test(text) && options.length > 2) return 2;
  for (let i = 0; i < options.length; i++) {
    const a = options[i]!.airline.toLowerCase();
    if (text.toLowerCase().includes(a)) return i;
  }
  return null;
}
