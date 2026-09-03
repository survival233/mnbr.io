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
