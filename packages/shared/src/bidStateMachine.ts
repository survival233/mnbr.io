/**
 * Bid state machine — PRD v4.0 §10.1. The ONLY source of truth for legal
 * transitions. The API layer MUST route every status change through
 * `assertTransition`. Illegal transitions throw and surface as 409s.
 */
export const BID_STATUSES = [
  "pending", "accepted", "funded", "purchased", "in_transit",
  "arrived", "delivered", "refunded", "disputed", "expired", "withdrawn",
] as const;

export type BidStatus = (typeof BID_STATUSES)[number];
export type Actor = "shopper" | "traveler" | "system" | "admin";

interface TransitionRule {
  to: BidStatus;
  actors: readonly Actor[];
  intent: string;
}

export const TRANSITIONS: Readonly<Record<BidStatus, readonly TransitionRule[]>> = {
  pending: [
    { to: "accepted", actors: ["shopper"], intent: "shopper accepts the bid" },
    { to: "expired", actors: ["system"], intent: "72h pending expiry" },
    { to: "withdrawn", actors: ["traveler"], intent: "traveler withdraws" },
  ],
  accepted: [
    { to: "funded", actors: ["system"], intent: "payment confirmed" },
    { to: "expired", actors: ["system"], intent: "acceptance lapsed unfunded" },
    { to: "withdrawn", actors: ["traveler", "admin"], intent: "withdraw before funding" },
  ],
  funded: [
    { to: "purchased", actors: ["traveler"], intent: "traveler bought the item" },
    { to: "refunded", actors: ["admin", "system"], intent: "cancel before purchase" },
  ],
  purchased: [
    { to: "in_transit", actors: ["traveler"], intent: "traveler departed" },
    { to: "refunded", actors: ["admin"], intent: "admin-resolved refund" },
  ],
  in_transit: [
    { to: "arrived", actors: ["traveler"], intent: "traveler arrived" },
    { to: "refunded", actors: ["admin"], intent: "admin-resolved refund" },
  ],
  arrived: [
    { to: "delivered", actors: ["system"], intent: "handover code confirmed" },
    { to: "refunded", actors: ["admin"], intent: "admin-resolved refund" },
  ],
  delivered: [
    { to: "disputed", actors: ["shopper", "traveler"], intent: "dispute within 48h" },
  ],
  disputed: [
    { to: "delivered", actors: ["admin"], intent: "dispute resolved: release stands" },
    { to: "refunded", actors: ["admin"], intent: "dispute resolved: refund" },
  ],
  refunded: [],
  expired: [],
  withdrawn: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: BidStatus,
    public readonly to: BidStatus,
    public readonly actor: Actor,
    reason: string,
  ) {
    super(`Illegal bid transition ${from} → ${to} by ${actor}: ${reason}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: BidStatus, to: BidStatus, actor: Actor): boolean {
  const rule = TRANSITIONS[from].find((r) => r.to === to);
  return rule !== undefined && rule.actors.includes(actor);
}

export function assertTransition(from: BidStatus, to: BidStatus, actor: Actor): TransitionRule {
  const rule = TRANSITIONS[from].find((r) => r.to === to);
  if (!rule) throw new IllegalTransitionError(from, to, actor, "no such edge in the state machine");
  if (!rule.actors.includes(actor)) {
    throw new IllegalTransitionError(from, to, actor, `only [${rule.actors.join(", ")}] may perform this transition`);
  }
  return rule;
}

export function availableTransitions(from: BidStatus, actor: Actor): BidStatus[] {
  return TRANSITIONS[from].filter((r) => r.actors.includes(actor)).map((r) => r.to);
}

export function isTerminal(status: BidStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function isFundsHeld(status: BidStatus): boolean {
  return status === "funded" || status === "purchased" || status === "in_transit" || status === "arrived" || status === "disputed";
}

export function mayExpire(status: BidStatus): boolean {
  return status === "pending" || status === "accepted";
}

export const STATUS_TIMESTAMP_FIELD: Partial<Record<BidStatus, string>> = {
  funded: "fundedAt",
  purchased: "purchasedAt",
  in_transit: "inTransitAt",
  arrived: "arrivedAt",
  delivered: "deliveredAt",
  refunded: "refundedAt",
};
