/**
 * Vector C — the traveler buys the shopper's item through the Commerce SDK on
 * the TRAVELER'S OWN card (their own linked Agentcard vault / payment system),
 * AFTER escrow has HELD the shopper's funds. The confirmed order total
 * reconciles against the held amount, and the traveler is reimbursed from
 * escrow (subtotal) plus Manebra's commission on handover. A real store receipt
 * (not "trust me, I bought it") gates that release.
 *
 * Money rails stay distinct:
 *   - Trust rail (ours): shopper -> escrow -> HELD -> released on handover
 *     (reimburses the traveler's subtotal + Manebra commission).
 *   - Purchase rail (traveler's): the traveler's OWN card -> store at buy time
 *     (+1% Agentcard live fee). Manebra never issues or funds this card.
 * Reconciliation protects both sides: the shopper's held funds must cover what
 * the traveler actually paid before any reimbursement, so a committed traveler
 * is never left out of pocket and the shopper is never overcharged.
 *
 * This module is intentionally injectable (ports), not wired into the live
 * settlement bridge. The app supplies the seams; nothing here moves money.
 */

/** How a confirmed order's total compares to the amount escrow is holding. */
export type ReconcileStatus = "match" | "over_tolerance" | "under";

export type ReconcileVerdict = {
  status: ReconcileStatus;
  /** orderTotalCents - heldCents. Positive means the order cost more than held. */
  deltaCents: number;
  /** True when the order may proceed to the next settlement step. */
  ok: boolean;
};

/**
 * Compare a confirmed order total to the held escrow amount.
 *
 * - `match`  — held funds cover the traveler's spend within tolerance; the
 *   reimbursement + commission release may proceed.
 * - `under`  — the traveler paid less than held; always ok, refund the
 *   difference to the shopper.
 * - `over_tolerance` — the traveler paid more than the shopper funded, beyond
 *   tolerance; NOT ok. The traveler would be under-reimbursed, so this needs a
 *   shopper top-up decision before any release — never auto-released.
 *
 * `toleranceBps` is basis points of the held amount allowed above it (e.g. 200
 * = 2%) to absorb tax/shipping drift. Default 0: any overage is flagged.
 */
export function reconcileOrderTotal(
  heldCents: number,
  orderTotalCents: number,
  toleranceBps = 0,
): ReconcileVerdict {
  if (!Number.isFinite(heldCents) || heldCents < 0) {
    throw new Error("heldCents must be a non-negative number");
  }
  if (!Number.isFinite(orderTotalCents) || orderTotalCents < 0) {
    throw new Error("orderTotalCents must be a non-negative number");
  }
  const deltaCents = orderTotalCents - heldCents;
  if (deltaCents <= 0) {
    return { status: deltaCents === 0 ? "match" : "under", deltaCents, ok: true };
  }
  const allowed = Math.floor((heldCents * toleranceBps) / 10_000);
  if (deltaCents <= allowed) {
    return { status: "match", deltaCents, ok: true };
  }
  return { status: "over_tolerance", deltaCents, ok: false };
}

/** The confirmed-order fields Vector C reads off an `order.*` event. */
export type ConfirmedOrder = {
  orderId: string | null;
  merchant: string;
  totalCents: number;
  status: string;
};

/**
 * Pull a `ConfirmedOrder` from an `order.*` event payload, or null when the
 * payload has no total yet. Shape-tolerant: the SDK nests the order under
 * `order` on some events and inlines it on others.
 */
export function orderFromEvent(data: Record<string, unknown>): ConfirmedOrder | null {
  const o = (data.order ?? data) as Record<string, unknown>;
  const totalCents = typeof o.total_cents === "number" ? o.total_cents : null;
  if (totalCents === null) return null;
  return {
    orderId: typeof o.order_id === "string" ? o.order_id : null,
    merchant: typeof o.merchant === "string" ? o.merchant : "",
    totalCents,
    status: typeof o.status === "string" ? o.status : "",
  };
}

/** Seams the app wires in. None of these are implemented here. */
export type VectorCPorts = {
  /** The escrow amount held for this trip, in cents. */
  heldAmountCents: (tripId: string) => Promise<number>;
  /**
   * Advance settlement after a clean reconcile — mark the item bought (receipt
   * proven) so the handover + release milestone can reimburse the traveler's
   * subtotal and pay Manebra's commission. Wire to the settlement bridge.
   */
  onReconciled: (tripId: string, order: ConfirmedOrder, verdict: ReconcileVerdict) => Promise<void>;
  /**
   * Flag an over-tolerance order — the shopper under-funded the trip, so the
   * traveler who paid on their own card would be under-reimbursed. Route to a
   * shopper top-up / human decision; never auto-release.
   */
  onOverage: (tripId: string, order: ConfirmedOrder, verdict: ReconcileVerdict) => Promise<void>;
};

/**
 * Handle one confirmed-order event for a trip: reconcile and route. Call this
 * from the Commerce listener's `onOrderEvent` once you've mapped the event's
 * actor/thread back to a trip id.
 *
 * The traveler buys on their OWN card, so there is no scoped card to fund here:
 * the buy tool is bound to the traveler's own `externalUserId` and their own
 * linked vault card (see `buyFor` in buy.ts). The held escrow is the shopper's
 * reimbursement budget, which this reconcile checks against the real receipt
 * before `onReconciled` lets the handover/release proceed.
 */
export async function handleConfirmedOrder(
  tripId: string,
  data: Record<string, unknown>,
  ports: VectorCPorts,
  toleranceBps = 0,
): Promise<ReconcileVerdict | null> {
  const order = orderFromEvent(data);
  if (!order) return null;
  const held = await ports.heldAmountCents(tripId);
  const verdict = reconcileOrderTotal(held, order.totalCents, toleranceBps);
  if (verdict.ok) {
    await ports.onReconciled(tripId, order, verdict);
  } else {
    await ports.onOverage(tripId, order, verdict);
  }
  return verdict;
}
