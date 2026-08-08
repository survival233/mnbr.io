/**
 * Matching agent — pure scoring core. Advisory-only: this ranks trip↔item
 * candidates; a human (or later, a bounded agent) decides. It moves no money
 * and touches no state, which is exactly why matching is the first agent.
 *
 * CRITICAL PROPERTY: the gates here mirror the kernel's own gates (direction,
 * per-direction category allowlist, new-traveler item cap, high-value trust
 * gate) so the agent never proposes a match that bids.create would reject.
 * Gate config is INJECTED — the server layer passes the real values from
 * @manebra/shared, keeping this module pure and exhaustively testable.
 */

export interface MatchGateConfig {
  categoriesByDirection: Readonly<Record<string, readonly string[]>>;
  newUserDeliveryThreshold: number; // below this, traveler is "new"
  newUserItemCapCents: number; // new travelers can't take items above this
  highValueItemCents: number; // items above this need trusted travelers
  highValueMinTrust: number;
}

export interface ItemCandidate {
  id: string;
  direction: string;
  destinationCity: string;
  category: string;
  itemCostCents: number;
  status: string; // must be "open"
  reviewStatus: string; // must be approved
  expiresAt: Date;
}

export interface TripCandidate {
  id: string;
  travelerId: string;
  direction: string;
  destinationCity: string;
  departureDate: Date;
  status: string; // must be "upcoming"
}

export interface TravelerCandidate {
  id: string;
  isVerified: boolean;
  accountStatus: string; // must be "active"
  trustScore: number; // 0–200, default 100
  avgRating: number | null; // 1–5
  totalDeliveries: number;
}

export type MatchResult =
  | { eligible: false; reasons: string[] }
  | { eligible: true; score: number; components: Record<string, number> };

const W = { date: 30, trust: 35, rating: 20, experience: 15 } as const; // sums to 100

export function scoreMatch(
  item: ItemCandidate,
  trip: TripCandidate,
  traveler: TravelerCandidate,
  cfg: MatchGateConfig,
  now: Date = new Date(),
): MatchResult {
  const reasons: string[] = [];

  // liveness
  if (item.status !== "open") reasons.push("item_not_open");
  if (!["approved", "auto_approved"].includes(item.reviewStatus)) reasons.push("item_not_approved");
  if (trip.status !== "upcoming") reasons.push("trip_not_upcoming");
  if (!traveler.isVerified) reasons.push("traveler_not_verified");
  if (traveler.accountStatus !== "active") reasons.push("traveler_not_active");

  // feasibility
  if (trip.direction !== item.direction) reasons.push("direction_mismatch");
  if (trip.destinationCity !== item.destinationCity) reasons.push("city_mismatch");
  if (trip.departureDate.getTime() <= now.getTime()) reasons.push("trip_departed");
  // Inclusive deadline: departing on the deliver-by instant still counts.
  if (trip.departureDate.getTime() > item.expiresAt.getTime()) reasons.push("departs_after_item_expiry");

  // kernel-mirrored compliance + risk gates
  const allowed = cfg.categoriesByDirection[item.direction] ?? [];
  if (!allowed.includes(item.category)) reasons.push("category_not_allowed_for_direction");
  const isNewTraveler = traveler.totalDeliveries < cfg.newUserDeliveryThreshold;
  if (isNewTraveler && item.itemCostCents > cfg.newUserItemCapCents) reasons.push("new_traveler_item_cap");
  if (item.itemCostCents > cfg.highValueItemCents && traveler.trustScore < cfg.highValueMinTrust) {
    reasons.push("high_value_trust_gate");
  }

  if (reasons.length > 0) return { eligible: false, reasons };

  // scoring (0–100)
  const windowMs = item.expiresAt.getTime() - now.getTime();
  const untilDepartureMs = trip.departureDate.getTime() - now.getTime();
  // sooner departure within the window is better (1 = departs now, 0 = departs at expiry)
  const dateComponent = windowMs > 0 ? Math.max(0, Math.min(1, 1 - untilDepartureMs / windowMs)) : 0;
  const trustComponent = Math.max(0, Math.min(1, traveler.trustScore / 200));
  const ratingComponent = traveler.avgRating == null ? 0.5 : Math.max(0, Math.min(1, (traveler.avgRating - 1) / 4));
  const experienceComponent = Math.max(0, Math.min(1, Math.log10(1 + traveler.totalDeliveries) / 2)); // 0→0, 9→~0.5, 99→1

  const components = {
    date: W.date * dateComponent,
    trust: W.trust * trustComponent,
    rating: W.rating * ratingComponent,
    experience: W.experience * experienceComponent,
  };
  const score = Math.round((components.date + components.trust + components.rating + components.experience) * 100) / 100;
  return { eligible: true, score, components };
}

/** Rank many candidates for one item; ineligible ones are dropped. */
export function rankTripsForItem(
  item: ItemCandidate,
  candidates: Array<{ trip: TripCandidate; traveler: TravelerCandidate }>,
  cfg: MatchGateConfig,
  now: Date = new Date(),
): Array<{ trip: TripCandidate; traveler: TravelerCandidate; score: number }> {
  return candidates
    .map((c) => ({ ...c, result: scoreMatch(item, c.trip, c.traveler, cfg, now) }))
    .filter((c): c is typeof c & { result: { eligible: true; score: number } } => c.result.eligible)
    .map((c) => ({ trip: c.trip, traveler: c.traveler, score: c.result.score }))
    .sort((a, b) => b.score - a.score);
}
