import { describe, it, expect } from "vitest";
import { evaluateSpend, type SpendPolicy } from "./spend-policy";
import type { Address } from "viem";

const ESCROW = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;

const policy: SpendPolicy = {
  maxPerTxBaseUnits: 500_000000n, // $500
  dailyCapBaseUnits: 1000_000000n, // $1000
  allowedContracts: [ESCROW],
};

describe("evaluateSpend", () => {
  it("allows an in-policy spend", () => {
    expect(evaluateSpend(policy, { to: ESCROW, amountBaseUnits: 138_000000n }, { spentTodayBaseUnits: 0n }))
      .toEqual({ allowed: true });
  });
  it("rejects zero and negative amounts", () => {
    expect(evaluateSpend(policy, { to: ESCROW, amountBaseUnits: 0n }, { spentTodayBaseUnits: 0n }))
      .toMatchObject({ allowed: false, reason: "non_positive_amount" });
    expect(evaluateSpend(policy, { to: ESCROW, amountBaseUnits: -1n }, { spentTodayBaseUnits: 0n }))
      .toMatchObject({ allowed: false, reason: "non_positive_amount" });
  });
  it("rejects over the per-tx cap", () => {
    expect(evaluateSpend(policy, { to: ESCROW, amountBaseUnits: 600_000000n }, { spentTodayBaseUnits: 0n }))
      .toMatchObject({ allowed: false, reason: "over_tx_cap" });
  });
  it("rejects when the daily window would overflow", () => {
    expect(evaluateSpend(policy, { to: ESCROW, amountBaseUnits: 400_000000n }, { spentTodayBaseUnits: 700_000000n }))
      .toMatchObject({ allowed: false, reason: "over_daily_cap" });
  });
  it("allows exactly at both caps (boundaries inclusive)", () => {
    expect(evaluateSpend(policy, { to: ESCROW, amountBaseUnits: 500_000000n }, { spentTodayBaseUnits: 500_000000n }))
      .toEqual({ allowed: true });
  });
  it("rejects contracts off the allowlist, case-insensitively on", () => {
    expect(evaluateSpend(policy, { to: OTHER, amountBaseUnits: 1n }, { spentTodayBaseUnits: 0n }))
      .toMatchObject({ allowed: false, reason: "contract_not_allowed" });
    expect(evaluateSpend(policy, { to: ESCROW.toUpperCase().replace("0X", "0x") as Address, amountBaseUnits: 1n }, { spentTodayBaseUnits: 0n }))
      .toEqual({ allowed: true });
  });
});
