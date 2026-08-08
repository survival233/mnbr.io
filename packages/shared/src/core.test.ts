/** Business-logic suite — fee math (PRD §2.2) + state machine (PRD §10.1). */
import { describe, it, expect } from "vitest";
import { computeFees, formatUsd } from "./money.js";
import { assertTransition, canTransition, isTerminal, isFundsHeld, mayExpire, IllegalTransitionError } from "./bidStateMachine.js";
import { generateHandoverCode, hashHandoverCode, verifyHandoverCode } from "./handover.js";
import { isCategoryAllowed } from "./categories.js";

describe("computeFees", () => {
  it("PRD worked example: $100 + $20 → $138 total", () => {
    const f = computeFees(10_000, 2_000);
    expect(f.subtotalCents).toBe(12_000);
    expect(f.commissionCents).toBe(1_800);
    expect(f.totalCents).toBe(13_800);
  });
  it("rounds half up on the cent", () => {
    // subtotal 101 → 15.15 → 15 ; subtotal 103 → 15.45 → 15 ; subtotal 110 → 16.5 → 17
    expect(computeFees(101, 0).commissionCents).toBe(15);
    expect(computeFees(110, 0).commissionCents).toBe(17);
  });
  it("rejects non-integer and negative cents, and zero item cost", () => {
    expect(() => computeFees(10.5 as unknown as number, 0)).toThrow(RangeError);
    expect(() => computeFees(-1, 0)).toThrow(RangeError);
    expect(() => computeFees(0, 100)).toThrow(RangeError);
  });
  it("formats USD", () => {
    expect(formatUsd(13800)).toBe("$138.00");
  });
});

describe("bid state machine", () => {
  it("happy path is legal end to end", () => {
    assertTransition("pending", "accepted", "shopper");
    assertTransition("accepted", "funded", "system");
    assertTransition("funded", "purchased", "traveler");
    assertTransition("purchased", "in_transit", "traveler");
    assertTransition("in_transit", "arrived", "traveler");
    assertTransition("arrived", "delivered", "system");
  });
  it("rejects wrong actors", () => {
    expect(() => assertTransition("pending", "accepted", "traveler")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("arrived", "delivered", "traveler")).toThrow(IllegalTransitionError);
  });
  it("rejects state-skipping", () => {
    expect(() => assertTransition("funded", "delivered", "system")).toThrow(IllegalTransitionError);
    expect(canTransition("pending", "funded", "system")).toBe(false);
  });
  it("terminal states are sealed", () => {
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(() => assertTransition("refunded", "funded", "admin")).toThrow(IllegalTransitionError);
  });
  it("expiry is forbidden for funded states", () => {
    expect(mayExpire("pending")).toBe(true);
    expect(mayExpire("funded")).toBe(false);
    expect(canTransition("funded", "expired", "system")).toBe(false);
  });
  it("refund paths stay open exactly while funds are held", () => {
    for (const s of ["funded", "purchased", "in_transit", "arrived", "disputed"] as const) {
      expect(isFundsHeld(s)).toBe(true);
      expect(canTransition(s, "refunded", "admin")).toBe(true);
    }
    expect(isFundsHeld("pending")).toBe(false);
  });
});

describe("handover codes", () => {
  it("6 digits, leading zeros allowed", () => {
    for (let i = 0; i < 20; i++) expect(generateHandoverCode()).toMatch(/^\d{6}$/);
  });
  it("verifies bid-bound and constant-time", () => {
    const h = hashHandoverCode("123456", "bid-1", "secret");
    expect(verifyHandoverCode("123456", "bid-1", h, "secret")).toBe(true);
    expect(verifyHandoverCode("123456", "bid-2", h, "secret")).toBe(false); // other bid
    expect(verifyHandoverCode("654321", "bid-1", h, "secret")).toBe(false); // wrong code
  });
});

describe("categories", () => {
  it("per-direction allowlist", () => {
    expect(isCategoryAllowed("us_to_gh", "electronics")).toBe(true);
    expect(isCategoryAllowed("gh_to_us", "electronics")).toBe(false);
    expect(isCategoryAllowed("gh_to_us", "textiles_kente")).toBe(true);
  });
});
