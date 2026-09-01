import { describe, expect, it } from "vitest";
import { paySheetUrl, nextShopperFundingStep } from "./PaySheet";

describe("PaySheet amount is the recap total", () => {
  it("appends merchant + amount cents exactly", () => {
    const recapTotalCents = 12_345;
    const url = paySheetUrl("https://app.agentcard.sh/w/wl_test.token", "Manebra", recapTotalCents);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("amount")).toBe("12345");
    expect(parsed.searchParams.get("merchant")).toBe("Manebra");
  });

  it("rejects a non-recap amount", () => {
    expect(() => paySheetUrl("https://app.agentcard.sh/w/wl_x", "Manebra", 0)).toThrow(/recap total/);
  });
});

describe("nextShopperFundingStep", () => {
  it("uses Anvil only in demo when AGENTCARD_* is unset", () => {
    expect(nextShopperFundingStep({ configured: false, hasCard: false, paySheetSent: false })).toBe("unconfigured");
    expect(nextShopperFundingStep({ configured: false, hasCard: false, paySheetSent: false, demo: true })).toBe("anvil");
  });

  it("sends wallet first when there is no connected card, then pay-sheet on recap confirm", () => {
    expect(nextShopperFundingStep({ configured: true, hasCard: false, paySheetSent: false })).toBe("wallet");
    expect(nextShopperFundingStep({ configured: true, hasCard: true, paySheetSent: false })).toBe("paysheet");
    expect(nextShopperFundingStep({ configured: true, hasCard: true, paySheetSent: true })).toBe("wait_payment");
  });
});
