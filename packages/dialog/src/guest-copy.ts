import { formatUsd } from "@manebra/shared";

export const SHOP_PLACE_ASK = "Where should I shop from — a city or a country?";
export const SHOP_PLACE_NO_MARKET =
  "I don’t have a store catalog there yet. A US city or the US as a country works.";

/** Exact shopper earnings ask — never invent a dollar amount. */
export const EARNINGS_ASK = "What’s fair to pay the traveler for this?";

export function recapTotalCents(itemCents: number, taxCents: number, earningsCents: number): number {
  return itemCents + taxCents + earningsCents;
}

/** Realistic sales-tax estimate when the catalog row has none. */
export function estimateTaxCents(itemCents: number, merchant: string): number {
  const m = merchant.toLowerCase();
  let bps = 800;
  if (/\bapple\b/.test(m)) bps = 875;
  else if (/\bwalmart\b/.test(m)) bps = 725;
  else if (/\btarget\b/.test(m)) bps = 800;
  else if (/\bamazon\b/.test(m)) bps = 800;
  else if (/best\s*buy/.test(m)) bps = 800;
  return Math.round((itemCents * bps) / 10_000);
}

export function taxCentsFor(listing: {
  priceCents: number;
  taxCents?: number | null;
  storeName: string;
}): number {
  if (listing.taxCents != null && Number.isFinite(listing.taxCents) && listing.taxCents >= 0) {
    return listing.taxCents;
  }
  return estimateTaxCents(listing.priceCents, listing.storeName);
}

export const SKU_FOUND = "Found a few — any of these, or want me to narrow?";
export const SKU_TOO_FEW =
  "I couldn’t get enough product photos. What should I search instead?";

export function shortListingTitle(title: string, max = 48): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 3).trim()}...`;
}

export function listingHasPhoto(imageUrl?: string | null): boolean {
  return /^https?:\/\//i.test(imageUrl?.trim() ?? "");
}

export function listingCaption(args: { title: string; merchant: string; priceCents: number }): string {
  return `${shortListingTitle(args.title)} · ${args.merchant} · ${formatUsd(args.priceCents)}`;
}

export type ChatMediaPart = {
  type: "media";
  url: string;
  media_kind: "image";
  content_type: string;
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
}): ChatPart[] {
  const url = args.imageUrl?.trim() ?? "";
  if (!listingHasPhoto(url)) return [];
  return [
    {
      type: "media",
      url,
      media_kind: "image",
      content_type: guessImageContentType(url),
    },
    { type: "text", text: listingCaption(args) },
  ];
}

export function lineTaxCents(
  listing: { priceCents: number; taxCents?: number | null; storeName: string },
  qty = 1,
): number {
  const q = Math.max(1, qty);
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
}): string {
  const total = recapTotalCents(args.itemCents, args.taxCents, args.earningsCents);
  return (
    `${args.title} at ${args.merchant}\n` +
    `Item ${formatUsd(args.itemCents)}\n` +
    `Tax ${formatUsd(args.taxCents)}\n` +
    `Traveler ${formatUsd(args.earningsCents)}\n` +
    `Total ${formatUsd(total)}`
  );
}

/** Recap wait — confirm of the shown hash opens the pay-sheet. Matching starts after funded. */
export const RECAP_PAY_ASK = "That’s the total. Say yes and I’ll send the pay sheet.";

export const PAYMENT_UNCONFIGURED = "Payment isn’t configured on this host yet.";

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
