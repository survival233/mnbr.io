import { describe, expect, it } from "vitest";
import {
  briefConfirmCopy,
  canConfirmHeadingYourWay,
  claimsHeadingYourWay,
  keepLookingCopy,
  nextUntriedIndex,
  noMatchCopy,
  offerTimedOut,
  requestExpiredCopy,
  requestPastDeadline,
  searchingCopy,
  shopperStillWaiting,
  TRAVELER_OFFER_TIMEOUT_MS,
  travelerAgreedCopy,
  waitingCopy,
} from "./match-policy.mts";

const ranked = [
  { id: "a", name: "Ada" },
  { id: "b", name: "Ben" },
  { id: "c", name: "Cam" },
];

describe("shopper copy before accept", () => {
  it("search / no-match / wait / keep-looking never claim someone is heading your way", () => {
    for (const line of [
      searchingCopy("Lagos"),
      noMatchCopy("London"),
      waitingCopy("Kumasi"),
      keepLookingCopy("New York"),
      briefConfirmCopy("Accra"),
      requestExpiredCopy("Lagos"),
    ]) {
      expect(claimsHeadingYourWay(line)).toBe(false);
      expect(line).not.toMatch(/\bAma\b|\bKofi\b|\bNana\b/i);
    }
  });

  it("agreed copy is the only heading-your-way confirmation", () => {
    const line = travelerAgreedCopy("Ada", "Lagos");
    expect(claimsHeadingYourWay(line)).toBe(true);
    expect(line).toMatch(/agreed/i);
    expect(line).toMatch(/Lagos/);
  });
});

describe("sequential assignment", () => {
  it("offers the first untried traveler", () => {
    expect(nextUntriedIndex(ranked, [])).toBe(0);
    expect(nextUntriedIndex(ranked, ["a"])).toBe(1);
    expect(nextUntriedIndex(ranked, ["a", "b"])).toBe(2);
  });

  it("returns null when every ranked traveler was tried (keep request open)", () => {
    expect(nextUntriedIndex(ranked, ["a", "b", "c"])).toBe(null);
    expect(nextUntriedIndex([], [])).toBe(null);
  });

  it("skips a declined traveler even if they were not first", () => {
    expect(nextUntriedIndex(ranked, ["b"])).toBe(0);
  });
});

describe("timeouts and cancel race", () => {
  it("times out an unanswered traveler after 2 hours", () => {
    const opened = new Date("2026-08-31T00:00:00Z");
    expect(offerTimedOut(opened, opened.getTime() + TRAVELER_OFFER_TIMEOUT_MS - 1)).toBe(false);
    expect(offerTimedOut(opened, opened.getTime() + TRAVELER_OFFER_TIMEOUT_MS)).toBe(true);
  });

  it("closes the request after the shopper need-by", () => {
    const by = new Date("2026-09-01T23:59:59Z");
    expect(requestPastDeadline(by, by.getTime())).toBe(false);
    expect(requestPastDeadline(by, by.getTime() + 1)).toBe(true);
    expect(requestPastDeadline(undefined, Date.now())).toBe(false);
  });

  it("drops a traveler accept when the shopper is no longer waiting on that offer", () => {
    expect(shopperStillWaiting("await_traveler_decision", "req-1", "req-1")).toBe(true);
    expect(shopperStillWaiting("await_product", "req-1", "req-1")).toBe(false);
    expect(shopperStillWaiting("await_traveler_decision", undefined, "req-1")).toBe(false);
    expect(shopperStillWaiting("await_traveler_decision", "req-2", "req-1")).toBe(false);
    expect(
      canConfirmHeadingYourWay({
        offerStatus: "accepted",
        shopperWaiting: false,
      }),
    ).toBe(false);
  });

  it("confirms heading your way only on accepted + still waiting", () => {
    expect(
      canConfirmHeadingYourWay({ offerStatus: "offered", shopperWaiting: true }),
    ).toBe(false);
    expect(
      canConfirmHeadingYourWay({ offerStatus: "accepted", shopperWaiting: true }),
    ).toBe(true);
    expect(
      canConfirmHeadingYourWay({ offerStatus: "cancelled", shopperWaiting: true }),
    ).toBe(false);
  });
});
