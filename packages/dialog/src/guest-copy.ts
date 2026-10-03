import { formatUsd } from "@manebra/shared";

export const SHOP_PLACE_ASK = "Where should I shop from — a city or a country?";
export const SHOP_PLACE_NO_MARKET =
  "I don’t have a store catalog there yet. A US city or the US as a country works.";

/** Exact shopper earnings ask — never invent a dollar amount. */
export const EARNINGS_ASK = "What’s fair to pay the traveler for this?";

export function recapTotalCents(itemCents: number, taxCents: number, earningsCents: number): number {
  return itemCents + taxCents + earningsCents;
}

/** Realistic sales-tax estimate when the catalog row has none. Fallback 8%. */
export function estimateTaxCents(itemCents: number, _merchant?: string): number {
  return Math.round((itemCents * 800) / 10_000);
}

export function taxCentsFor(listing: {
  priceCents: number;
  taxCents?: number | null;
  storeName: string;
  includesTax?: boolean;
}): number {
  if (listing.includesTax) return 0;
  if (listing.taxCents != null && Number.isFinite(listing.taxCents) && listing.taxCents >= 0) {
    return listing.taxCents;
  }
  return estimateTaxCents(listing.priceCents, listing.storeName);
}

export const SKU_FOUND = "Pick 1–4, or name the store.";
export const SKU_TOO_FEW =
  "I couldn’t find enough listings. What should I search instead?";

export function shortListingTitle(title: string, max = 48): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 3).trim()}...`;
}

export function listingHasPhoto(imageUrl?: string | null): boolean {
  return /^https?:\/\//i.test(imageUrl?.trim() ?? "");
}

export function listingCaption(args: {
  title: string;
  merchant: string;
  priceCents: number;
  n?: number;
}): string {
  const line = `${shortListingTitle(args.title)} · ${args.merchant} · ${formatUsd(args.priceCents)}`;
  return args.n != null ? `${args.n}. ${line}` : line;
}

export type ChatMediaPart = {
  type: "media";
  url: string;
  media_kind: "image";
  mime_type: string;
};

export type ChatTextPart = { type: "text"; text: string };

export type ChatPart = ChatMediaPart | ChatTextPart;

export function guessImageContentType(url: string): string {
  if (/\.png(\?|$)/i.test(url)) return "image/png";
  if (/\.webp(\?|$)/i.test(url)) return "image/webp";
  if (/\.gif(\?|$)/i.test(url)) return "image/gif";
  return "image/jpeg";
}

/** Relay outbound: image URL as a media part, caption as text. Skip rows with no photo. */
export function listingImageParts(args: {
  title: string;
  merchant: string;
  priceCents: number;
  imageUrl?: string | null;
  contentType?: string | null;
  n?: number;
}): ChatPart[] {
  const url = args.imageUrl?.trim() ?? "";
  if (!listingHasPhoto(url)) return [];
  const mime_type = args.contentType?.trim() || guessImageContentType(url);
  return [
    {
      type: "media",
      url,
      media_kind: "image",
      mime_type,
    },
    { type: "text", text: listingCaption(args) },
  ];
}

export function lineTaxCents(
  listing: { priceCents: number; taxCents?: number | null; storeName: string; includesTax?: boolean },
  qty = 1,
): number {
  const q = Math.max(1, qty);
  if (listing.includesTax) return 0;
  if (listing.taxCents != null && Number.isFinite(listing.taxCents) && listing.taxCents >= 0) {
    return listing.taxCents * q;
  }
  return estimateTaxCents(listing.priceCents * q, listing.storeName);
}

export function recapHash(parts: {
  sku: string;
  qty: number;
  itemCents: number;
  taxCents: number;
  earningsCents: number;
  totalCents: number;
  handoverCity: string;
}): string {
  const raw = [
    parts.sku,
    String(Math.max(1, parts.qty)),
    String(parts.itemCents),
    String(parts.taxCents),
    String(parts.earningsCents),
    String(parts.totalCents),
    parts.handoverCity.trim().toLowerCase(),
  ].join("|");
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function recapBody(args: {
  title: string;
  merchant: string;
  itemCents: number;
  taxCents: number;
  earningsCents: number;
  taxEstimated?: boolean;
}): string {
  const total = recapTotalCents(args.itemCents, args.taxCents, args.earningsCents);
  const taxLabel = args.taxEstimated ? "Tax (est.)" : "Tax";
  return (
    `${args.title} at ${args.merchant}\n` +
    `Item ${formatUsd(args.itemCents)}\n` +
    `${taxLabel} ${formatUsd(args.taxCents)}\n` +
    `Traveler ${formatUsd(args.earningsCents)}\n` +
    `Total ${formatUsd(total)}`
  );
}

/** Recap wait — confirm of the shown hash opens the pay-sheet. Matching starts after funded. */
export const RECAP_PAY_ASK = "That’s the total. Say yes and I’ll send the pay sheet.";

export const PAYMENT_UNCONFIGURED = "Payment isn’t configured on this host yet.";
/** Login failed after recap yes. Host retries wallet_links; do not ask them to say yes again. */
export const PAYMENT_WAIT =
  "Payment login failed. I’ll send a fresh wallet link when it’s back.";
/** @deprecated Use PAYMENT_WAIT — recap yes must not loop mint. */
export const PAYMENT_RETRY = PAYMENT_WAIT;

export const WALLET_ADD_CARD = "Add a test card (4242…) so you can fund. That’s once — I’ll reuse it after.";

/** Fresh wallet_links: expired link, resend, or first attach. */
export function asksForFreshWallet(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return (
    /\b(wallet|pay[\s-]?sheet|agent\s*card)\b/i.test(t) &&
    /\b(new|fresh|another|resend|send|expir|again|link)\b/i.test(t)
  );
}

/** Host-agnostic picker row. Relay: image-if-url else numbered 1..n. A future app can render cards. */
export type ListingRecord = {
  n: number;
  title: string;
  merchant: string;
  priceCents: number;
  imageUrl?: string | null;
};

export function listingRecords(
  listings: Array<{
    productTitle: string;
    storeName: string;
    priceCents: number;
    imageUrl?: string | null;
  }>,
): ListingRecord[] {
  return listings.map((l, i) => ({
    n: i + 1,
    title: l.productTitle,
    merchant: l.storeName,
    priceCents: l.priceCents,
    imageUrl: l.imageUrl?.trim() || null,
  }));
}

export type RequestPhase = "funded" | "matching" | "accepted" | "shopping";

export function requestStatusLine(phase: RequestPhase): string {
  return `${phase.charAt(0).toUpperCase()}${phase.slice(1)}.`;
}

export function shopperWait(handoverCity: string): string {
  return `I’ll ask travelers already heading to ${handoverCity}. You’ll hear back when someone takes it.`;
}

export function shopperNobody(handoverCity: string): string {
  return `Nobody on a trip to ${handoverCity} has taken it yet. I’ll keep it up.`;
}

export function shopperAccepted(handoverCity: string): string {
  return `Someone heading to ${handoverCity} took it.`;
}

export const TRAVELER_SKU_GONE =
  "That item’s gone. Similar listing, cancel, or text the shopper?";

export const TRAVELER_OVER_CAP =
  "Live price is over what they funded. Need a top-up before I buy — or I skip it.";

/** Phase 0 hi — no calendar, no speculative Shop & Deliver. */
export const TRAVELER_HI =
  "Two things I can do: (1) book a flight — that’s coming — or (2) save where you’re headed. Name a city and roughly when.";

export const TRAVELER_FLIGHT_STUB =
  "Flight booking’s coming. Tell me a city and roughly when and I’ll keep the trip.";

export const TRAVELER_DEST_ASK = "Where are you headed?";

export const TRAVELER_WHEN_ASK = "Roughly when do you arrive?";

export const TRAVELER_OPT_IN_ASK =
  "Want Shop & Deliver on this trip? I’ll only ping you when a shopper already funded a matching request. Yes or no.";

export const TRAVELER_TRIP_SAVED = "Trip’s on file.";

export const TRAVELER_OPTED_OUT =
  "Got it — no Shop & Deliver on this trip. Ping me if you change your mind.";

export const TRAVELER_WALLET_ADD =
  "Add a test card (4242…) so you can shop with yours. That’s once — I’ll reuse it after.";

export const TRAVELER_CARD_ON_FILE = "Card’s on file. I’ll use it when you shop.";

/** Phase 1 Connect Calendar. Not shown on the Phase 0 hi menu. */
export const CALENDAR_CONNECT_HEADLINE =
  "I can spot confirmed flights on your calendar so I know when you’re traveling.";

export const CALENDAR_CONNECT_PRIMARY = "Connect Calendar";

export const CALENDAR_CONNECT_LATER = "Set up later";

export const CALENDAR_PRIVACY =
  "Calendar data isn’t sold, used for ads, or used to train general-purpose AI models. How we use your data: we keep the city and time of a confirmed flight, not the raw calendar event.";

export const CALENDAR_CONNECTED = "Calendar’s connected. Checking for confirmed flights.";

export const CALENDAR_NONE =
  "No confirmed flights on that calendar. Tell me a city and roughly when, and I’ll keep the trip.";

export const CALENDAR_OAUTH_FAILED =
  "Calendar connect didn’t finish. You can try Connect Calendar again, or Set up later and tell me where you’re headed.";

export const CALENDAR_GMAIL_STUB =
  "Inbox isn’t part of this step. Connect Calendar reads flights only, or tell me where you’re headed.";

export const CALENDAR_APPLE_STUB =
  "Phone calendar isn’t available on this host yet. Connect Calendar uses Google, or tell me where you’re headed.";

export const CALENDAR_UNCONFIGURED =
  "Connect Calendar isn’t set up on this host yet. Set up later still works — tell me a city and roughly when.";

export const CALENDAR_ALREADY =
  "Calendar’s already connected. I’ll check it again for confirmed flights.";

export const CALENDAR_DISCONNECTED =
  "Calendar’s disconnected. Trips you already opted into stay on file. New flights won’t sync.";

export function calendarTripProposal(city: string, whenLabel: string): string {
  return `I see a confirmed flight to ${city} on ${whenLabel}. This trip stays with Manebra even if you disconnect Calendar later.`;
}

export function calendarConnectLines(): string[] {
  return [CALENDAR_CONNECT_HEADLINE, CALENDAR_CONNECT_PRIMARY, CALENDAR_CONNECT_LATER, CALENDAR_PRIVACY];
}

const BANNED_GUEST =
  /\b(carry|carrier|courier|package|delivery fee|reward|delivery job)\b/i;

export function guestCopyHasBannedTerm(text: string): boolean {
  return BANNED_GUEST.test(text);
}

export function wantsCalendarConnect(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\b(gmail|inbox|e-?mail)\b/i.test(t) && !/\bcalendar\b/i.test(t)) return false;
  return (
    /\b(connect|link|sync)\b[\s\S]{0,40}\b(calendar|google calendar)\b/i.test(t) ||
    /\b(calendar|google calendar)\b[\s\S]{0,40}\b(connect|link|sync)\b/i.test(t) ||
    /\blink google\b/i.test(t)
  );
}

export function wantsGmailConnect(text: string): boolean {
  return /\b(connect|link|sync)\b[\s\S]{0,40}\b(gmail|inbox)\b/i.test(text) && !/\bcalendar\b/i.test(text);
}

export function wantsPhoneCalendar(text: string): boolean {
  return /\b(apple|iphone|phone)\b[\s\S]{0,24}\bcalendar\b/i.test(text) || /\bcalendar\b[\s\S]{0,24}\b(apple|iphone)\b/i.test(text);
}

export function dismissesCalendarSetup(text: string): boolean {
  return /\bset up later\b/i.test(text) || /^(later|not now|skip)\b/i.test(text.trim());
}

export function choosesWhereHeaded(text: string): boolean {
  const t = text.trim();
  if (/^(2|two)\b/.test(t)) return true;
  return /\bwhere (i(?:'|’)m|i am) headed\b/i.test(t);
}

export function asksToBookFlight(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (/^(1|one)\b/.test(t) && !/\b(2|two|headed|going|city)\b/i.test(t)) return true;
  return /\b(book( a)? flight|flight booking|buy( a)? (ticket|flight))\b/i.test(t);
}

export function travelerMarketplaceLine(args: {
  earningsCents: number;
  title: string;
  metro: string;
}): string {
  return `You can earn ${formatUsd(args.earningsCents)} by Shop & Deliver of ${args.title} to a verified shopper in ${args.metro}.`;
}

export function travelerAsk(args: {
  city: string;
  title: string;
  merchant: string;
  itemCents: number;
  earningsCents: number;
}): string[] {
  return [
    `You’re going to ${args.city}.`,
    `Someone needs ${args.title} (${args.merchant}, ${formatUsd(args.itemCents)}).`,
    `Traveler earnings ${formatUsd(args.earningsCents)}.`,
    `Want it?`,
  ];
}

const PRE_ACCEPT_ASSIGN = /i(?:'|’)ll send this to\b|sent this to\b|heading your way/i;
const INVENTED_THIRTY = /\$30 is a common (?:gap|cap)/i;

export function assignsTravelerBeforeAccept(text: string): boolean {
  return PRE_ACCEPT_ASSIGN.test(text);
}

export function inventsThirtyEarnings(text: string): boolean {
  return INVENTED_THIRTY.test(text);
}
