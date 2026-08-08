/**
 * Shopper-facing shopping-request labels mapped onto ItemRequest + Bid state.
 * Internal enums stay authoritative; these are display/API conveniences.
 */
export type ShoppingRequestUiStatus =
  | "waiting_for_traveler"
  | "traveler_accepted"
  | "payment_confirmed"
  | "traveler_purchasing"
  | "in_transit"
  | "arrived"
  | "delivered"
  | "refunded"
  | "canceled";

export function shoppingRequestUiStatus(args: {
  itemStatus: string;
  reservedTravelerId: string | null;
  bidStatus?: string | null;
}): ShoppingRequestUiStatus {
  if (args.itemStatus === "canceled" || args.itemStatus === "expired") return "canceled";
  if (args.itemStatus === "completed") return "delivered";

  const bid = args.bidStatus;
  if (bid === "funded") return "payment_confirmed";
  if (bid === "purchased") return "traveler_purchasing";
  if (bid === "in_transit") return "in_transit";
  if (bid === "arrived") return "arrived";
  if (bid === "delivered") return "delivered";
  if (bid === "refunded") return "refunded";
  if (bid === "accepted" || bid === "pending" || args.reservedTravelerId) return "traveler_accepted";

  return "waiting_for_traveler";
}

/** Suggested delivery fee (cents) shown to travelers on job alerts — server-authored. */
export function suggestedTravelerFeeCents(itemCostCents: number): number {
  // Base $25 + 1.5% of item, clamped $15–$80
  const raw = 2500 + Math.round(itemCostCents * 0.015);
  return Math.min(8000, Math.max(1500, raw));
}
