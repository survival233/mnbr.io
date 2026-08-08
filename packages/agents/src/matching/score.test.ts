import { describe, it, expect } from "vitest";
import { scoreMatch, rankTripsForItem, type MatchGateConfig, type ItemCandidate, type TripCandidate, type TravelerCandidate } from "./score";

const NOW = new Date("2026-08-01T00:00:00Z");
const cfg: MatchGateConfig = {
  categoriesByDirection: {
    us_to_gh: ["electronics", "clothing_shoes"],
    gh_to_us: ["textiles_kente"],
  },
  newUserDeliveryThreshold: 3,
  newUserItemCapCents: 20_000, // $200
  highValueItemCents: 50_000, // $500
  highValueMinTrust: 120,
};

const item = (o: Partial<ItemCandidate> = {}): ItemCandidate => ({
  id: "item-1", direction: "us_to_gh", destinationCity: "Accra", category: "electronics",
  itemCostCents: 10_000, status: "open", reviewStatus: "auto_approved",
  expiresAt: new Date("2026-08-31T00:00:00Z"), ...o,
});
const trip = (o: Partial<TripCandidate> = {}): TripCandidate => ({
  id: "trip-1", travelerId: "t-1", direction: "us_to_gh", destinationCity: "Accra",
  departureDate: new Date("2026-08-10T00:00:00Z"), status: "upcoming", ...o,
});
const traveler = (o: Partial<TravelerCandidate> = {}): TravelerCandidate => ({
  id: "t-1", isVerified: true, accountStatus: "active", trustScore: 100, avgRating: 4.5, totalDeliveries: 10, ...o,
});

describe("gates", () => {
  it("eligible baseline", () => {
    expect(scoreMatch(item(), trip(), traveler(), cfg, NOW)).toMatchObject({ eligible: true });
  });
  const cases: Array<[string, Parameters<typeof scoreMatch>, string]> = [
    ["closed item", [item({ status: "funded" }), trip(), traveler(), cfg, NOW], "item_not_open"],
    ["unreviewed item", [item({ reviewStatus: "pending_review" }), trip(), traveler(), cfg, NOW], "item_not_approved"],
    ["non-upcoming trip", [item(), trip({ status: "completed" }), traveler(), cfg, NOW], "trip_not_upcoming"],
    ["unverified traveler", [item(), trip(), traveler({ isVerified: false }), cfg, NOW], "traveler_not_verified"],
    ["frozen traveler", [item(), trip(), traveler({ accountStatus: "frozen" }), cfg, NOW], "traveler_not_active"],
    ["direction mismatch", [item(), trip({ direction: "gh_to_us" }), traveler(), cfg, NOW], "direction_mismatch"],
    ["city mismatch", [item(), trip({ destinationCity: "Kumasi" }), traveler(), cfg, NOW], "city_mismatch"],
    ["already departed", [item(), trip({ departureDate: new Date("2026-07-01T00:00:00Z") }), traveler(), cfg, NOW], "trip_departed"],
    ["departs after expiry", [item(), trip({ departureDate: new Date("2026-09-15T00:00:00Z") }), traveler(), cfg, NOW], "departs_after_item_expiry"],
    ["category not allowed for direction", [item({ category: "textiles_kente" }), trip(), traveler(), cfg, NOW], "category_not_allowed_for_direction"],
    ["new traveler over item cap", [item({ itemCostCents: 30_000 }), trip(), traveler({ totalDeliveries: 1 }), cfg, NOW], "new_traveler_item_cap"],
    ["high-value below trust gate", [item({ itemCostCents: 60_000 }), trip(), traveler({ trustScore: 110 }), cfg, NOW], "high_value_trust_gate"],
  ];
  for (const [name, args, reason] of cases) {
    it(`gate: ${name} → ${reason}`, () => {
      const r = scoreMatch(...args);
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.reasons).toContain(reason);
    });
  }
  it("kernel mirror: experienced traveler CAN take an over-cap item", () => {
    expect(scoreMatch(item({ itemCostCents: 30_000 }), trip(), traveler({ totalDeliveries: 10 }), cfg, NOW))
      .toMatchObject({ eligible: true });
  });
  it("kernel mirror: trusted traveler CAN take a high-value item", () => {
    expect(scoreMatch(item({ itemCostCents: 60_000 }), trip(), traveler({ trustScore: 150 }), cfg, NOW))
      .toMatchObject({ eligible: true });
  });
  it("inclusive deadline: departure equal to expiresAt is eligible", () => {
    const expiresAt = new Date("2026-08-15T23:59:00Z");
    expect(scoreMatch(
      item({ expiresAt }),
      trip({ departureDate: new Date("2026-08-15T23:59:00Z") }),
      traveler(),
      cfg,
      NOW,
    )).toMatchObject({ eligible: true });
  });
  it("inclusive deadline: departure after expiresAt is ineligible", () => {
    const expiresAt = new Date("2026-08-15T23:59:00Z");
    const r = scoreMatch(
      item({ expiresAt }),
      trip({ departureDate: new Date("2026-08-16T00:00:00Z") }),
      traveler(),
      cfg,
      NOW,
    );
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reasons).toContain("departs_after_item_expiry");
  });
});

describe("scoring", () => {
  const s = (t: TravelerCandidate, tr: TripCandidate = trip()) => {
    const r = scoreMatch(item(), tr, t, cfg, NOW);
    if (!r.eligible) throw new Error("expected eligible");
    return r.score;
  };
  it("higher trust scores higher", () => {
    expect(s(traveler({ trustScore: 180 }))).toBeGreaterThan(s(traveler({ trustScore: 80 })));
  });
  it("sooner departure scores higher", () => {
    expect(s(traveler(), trip({ departureDate: new Date("2026-08-03T00:00:00Z") })))
      .toBeGreaterThan(s(traveler(), trip({ departureDate: new Date("2026-08-25T00:00:00Z") })));
  });
  it("higher rating scores higher; unrated is neutral not zero", () => {
    expect(s(traveler({ avgRating: 5 }))).toBeGreaterThan(s(traveler({ avgRating: 3 })));
    expect(s(traveler({ avgRating: null }))).toBeGreaterThan(s(traveler({ avgRating: 1 })));
  });
  it("score is bounded 0–100", () => {
    const max = s(traveler({ trustScore: 200, avgRating: 5, totalDeliveries: 100 }), trip({ departureDate: new Date("2026-08-01T00:00:01Z") }));
    expect(max).toBeLessThanOrEqual(100);
    expect(max).toBeGreaterThan(80);
  });
});

describe("rankTripsForItem", () => {
  it("drops ineligible, sorts by score desc", () => {
    const ranked = rankTripsForItem(item(), [
      { trip: trip({ id: "far", departureDate: new Date("2026-08-28T00:00:00Z") }), traveler: traveler() },
      { trip: trip({ id: "soon", departureDate: new Date("2026-08-03T00:00:00Z") }), traveler: traveler() },
      { trip: trip({ id: "wrong-city", destinationCity: "Kumasi" }), traveler: traveler() },
    ], cfg, NOW);
    expect(ranked.map((r) => r.trip.id)).toEqual(["soon", "far"]);
  });
});
