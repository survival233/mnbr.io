/**
 * Travel mode for the Manebra messaging agent:
 * NL → flight search → pick → book → trip → proactive earn.
 */
import {
  searchFlights,
  bookFlight,
  formatFlightOption,
  parseTravelIntent,
  toAirportCode,
  isoDate,
  type FlightOption,
} from "@manebra/flights";
import type { Session } from "./session.mts";
import { markSessionDirty } from "./session.mts";
import { persistBookedTrip, acceptEarnOffer, type EarnOffer } from "./traveler-bridge.mts";

type ReplyFn = (s: Session, text: string, opts?: { thinkMs?: number }) => Promise<void>;
type SayFn = (s: Session, ...bubbles: string[]) => Promise<void>;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function enterTravelMode(s: Session) {
  s.mode = "travel";
  s.step = "await_travel_intent";
  markSessionDirty();
}

export async function handleTravelInbound(
  s: Session,
  text: string,
  deps: { reply: ReplyFn; say: SayFn },
): Promise<boolean> {
  const { reply, say } = deps;
  const t = text.trim();

  if (s.step === "await_earn_opt_in" || s.step === "await_job_pick") {
    return handleEarn(s, t, deps);
  }

  if (s.step === "await_flight_pick" || s.step === "await_book_confirm") {
    return handlePickOrBook(s, t, deps);
  }

  // await_travel_intent or travel mode with free text
  return handleSearch(s, t, deps);
}

async function handleSearch(s: Session, text: string, deps: { reply: ReplyFn; say: SayFn }): Promise<boolean> {
  const { reply, say } = deps;
  const parsed = parseTravelIntent(text);
  if (parsed.origin) s.travelOrigin = toAirportCode(parsed.origin) ?? parsed.origin.toUpperCase();
  if (parsed.destination) {
    s.travelDestination = toAirportCode(parsed.destination) ?? parsed.destination.toUpperCase();
  }
  if (parsed.departDate) {
    s.travelDepartDate =
      typeof parsed.departDate === "string" ? parsed.departDate : isoDate(parsed.departDate);
  }
  if (parsed.arriveBy) s.travelArriveBy = parsed.arriveBy;
  markSessionDirty();

  if (!s.travelDestination) {
    s.step = "await_travel_intent";
    markSessionDirty();
    await reply(s, `Where do you need to fly? (e.g. New York, Accra, or JFK→ACC)`);
    return true;
  }
  if (!s.travelOrigin) {
    s.step = "await_travel_intent";
    markSessionDirty();
    await reply(
      s,
      `Got ${s.travelDestination} — where are you flying from? (city or airport code)`,
    );
    return true;
  }
  if (!s.travelDepartDate) {
    s.step = "await_travel_intent";
    markSessionDirty();
    await reply(s, `What day do you want to depart? (e.g. Friday, or 2026-08-15)`);
    return true;
  }

  await reply(s, `Searching ${s.travelOrigin} → ${s.travelDestination} on ${s.travelDepartDate}…`, {
    thinkMs: 500,
  });

  try {
    const options = await searchFlights({
      origin: s.travelOrigin,
      destination: s.travelDestination,
      departDate: s.travelDepartDate,
      arriveBy: s.travelArriveBy,
      limit: 3,
    });
    if (!options.length) {
      await reply(s, `No flights found for that route/date. Try another day or airports?`);
      return true;
    }
    s.flightOptions = options;
    s.step = "await_flight_pick";
    markSessionDirty();
    const lines = options.map((o, i) => formatFlightOption(o, i)).join("\n\n");
    const note = parsed.note ? `${parsed.note}.\n\n` : "";
    await say(
      s,
      `${note}Here are solid options:`,
      `${lines}\n\nReply with 1–${options.length}, or say something like “book the 8:30 PM”.`,
    );
  } catch (e: any) {
    console.warn(`[travel] search failed: ${e?.message ?? e}`);
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
    markSessionDirty();
    await reply(s, `Let’s start over — where and when do you want to fly?`);
    return true;
  }

  const idx = pickIndex(text, options);
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
  markSessionDirty();

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
    markSessionDirty();
    await say(s, booking.message, `I’ll watch for the confirmation and keep this trip on file.`);

    const { earnOffers } = await persistBookedTrip({ identity: s.phone, booking });
    s.earnOffers = earnOffers;
    if (earnOffers.length) {
      s.step = "await_earn_opt_in";
      markSessionDirty();
      await sleep(400);
      const top = earnOffers[0]!;
      await say(
        s,
        `You’re flying into ${top.destinationCity}. You could earn ~$${(top.feeCents / 100).toFixed(0)} bringing ${top.itemName} for a shopper.`,
        `Want to accept? (yes / no)`,
      );
    } else {
      s.step = "done";
      s.mode = "shop";
      markSessionDirty();
      await reply(
        s,
        `No open carry jobs on that route yet — I’ll ping you if one shows up. Say hi anytime to shop or search another flight.`,
      );
    }
  } catch (e: any) {
    console.warn(`[travel] book failed: ${e?.message ?? e}`);
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
    s.mode = "shop";
    markSessionDirty();
    await reply(s, `All good — trip stays on file. Ping me if you want jobs later.`);
    return true;
  }

  let offer: EarnOffer | undefined = offers[0];
  const n = parseInt(text, 10);
  if (n >= 1 && n <= offers.length) offer = offers[n - 1];
  if (!offer && !/^(y|yes|ok|okay|sure|yeah|yep|accept)\b/i.test(text)) {
    await reply(s, `Say yes to accept the carry job, or no to skip.`);
    return true;
  }
  if (!offer) {
    await reply(s, `Nothing to accept right now.`);
    return true;
  }

  const res = await acceptEarnOffer({ identity: s.phone, proposalId: offer.proposalId });
  s.step = "done";
  s.mode = "shop";
  markSessionDirty();
  await say(s, res.message);
  return true;
}

function pickIndex(text: string, options: FlightOption[]): number | null {
  const bare = text.trim().match(/^(\d+)\.?$/);
  if (bare) {
    const i = parseInt(bare[1]!, 10) - 1;
    if (i >= 0 && i < options.length) return i;
  }
  // “book the 8:30” / “8:30 pm”
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
    // nearest hour match
    for (let i = 0; i < options.length; i++) {
      if (options[i]!.departAt.getHours() === h) return i;
    }
  }
  if (/\b(first|1st)\b/i.test(text)) return 0;
  if (/\b(second|2nd)\b/i.test(text) && options.length > 1) return 1;
  if (/\b(third|3rd)\b/i.test(text) && options.length > 2) return 2;
  // “book the delta” / airline name
  for (let i = 0; i < options.length; i++) {
    const a = options[i]!.airline.toLowerCase();
    if (text.toLowerCase().includes(a)) return i;
  }
  return null;
}
