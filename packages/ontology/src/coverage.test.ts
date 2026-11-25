import { describe, expect, it } from "vitest";
import { coverage } from "./coverage";

describe("coverage", () => {
  it("is answerable for an eligible item at a payable store on a valid corridor", async () => {
    const r = await coverage(
      { category: "electronics", merchantDomain: "apple.com", direction: "us_to_gh" },
      { merchantPayable: async () => true, feasibleTrip: async () => true },
    );
    expect(r.answerable).toBe(true);
    expect(r.gaps).toEqual([]);
    expect(r.suggestion).toBeNull();
  });

  it("blocks a prohibited category and explains", async () => {
    const r = await coverage({ category: "weapons", merchantDomain: "amazon.com", direction: "us_to_gh" });
    expect(r.answerable).toBe(false);
    expect(r.gaps).toContain("category_not_eligible");
    expect(r.suggestion).toMatch(/can't be carried/i);
  });

  it("flags an always-review category but stays answerable", async () => {
    const r = await coverage({ category: "foodstuffs_cbp_permitted", merchantDomain: "amazon.com", direction: "gh_to_us" });
    expect(r.answerable).toBe(true);
    expect(r.requiresReview).toBe(true);
  });

  it("blocks an unpayable merchant", async () => {
    const r = await coverage(
      { category: "electronics", merchantDomain: "sketchy.example", direction: "us_to_gh" },
      { merchantPayable: async () => false },
    );
    expect(r.gaps).toContain("merchant_not_payable");
    expect(r.answerable).toBe(false);
  });

  it("blocks when no traveler is feasible", async () => {
    const r = await coverage(
      { category: "electronics", merchantDomain: "apple.com", direction: "us_to_gh" },
      { merchantPayable: async () => true, feasibleTrip: async () => false },
    );
    expect(r.gaps).toContain("no_feasible_trip");
  });

  it("collects unresolved terms as gaps", async () => {
    const r = await coverage({ category: null, merchantDomain: null, direction: null });
    expect(r.gaps).toEqual(expect.arrayContaining(["corridor_unresolved", "category_unresolved", "merchant_unresolved"]));
    expect(r.answerable).toBe(false);
  });

  it("records a trace of the checks it ran", async () => {
    const r = await coverage(
      { category: "electronics", merchantDomain: "apple.com", direction: "us_to_gh" },
      { merchantPayable: async () => true },
    );
    const steps = r.trace.map((t) => t.step);
    expect(steps).toEqual(expect.arrayContaining(["corridor", "compliance", "merchant", "merchant_payable"]));
  });
});
