/** Trust score — PRD §12. 0–200, default 100. */
export const TRUST_DEFAULT = 100;
export const TRUST_MIN = 0;
export const TRUST_MAX = 200;

export const TRUST_DELTAS = {
  delivery_completed: +10,
  five_star_rating: +5,
  dispute_resolved_against: -30,
  late_delivery: -10,
  bid_withdrawn_after_accept: -15,
} as const;

export function applyTrustDelta(current: number, delta: number): number {
  return Math.max(TRUST_MIN, Math.min(TRUST_MAX, current + delta));
}
