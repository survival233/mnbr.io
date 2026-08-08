import { describe, it, expect } from "vitest";
import { centsToUsdc, usdcToCents } from "./units";

describe("centsToUsdc", () => {
  it("maps the PRD worked example exactly", () => {
    expect(centsToUsdc(12000)).toBe(120_000000n); // $120 subtotal
    expect(centsToUsdc(1800)).toBe(18_000000n); // $18 commission
    expect(centsToUsdc(13800)).toBe(138_000000n); // $138 total
  });

  it("handles $1 and zero", () => {
    expect(centsToUsdc(100)).toBe(1_000000n);
    expect(centsToUsdc(0)).toBe(0n);
  });

  it("accepts bigint input", () => {
    expect(centsToUsdc(13800n)).toBe(138_000000n);
  });

  it("rejects negative amounts", () => {
    expect(() => centsToUsdc(-1)).toThrow();
  });

  it("round-trips through usdcToCents", () => {
    for (const cents of [0, 1, 100, 1800, 13800, 999999]) {
      expect(usdcToCents(centsToUsdc(cents))).toBe(cents);
    }
  });

  it("usdcToCents rejects sub-cent precision", () => {
    expect(() => usdcToCents(1_000001n)).toThrow(); // not a whole number of cents
  });
});
