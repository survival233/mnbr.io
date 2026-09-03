import { describe, expect, it } from "vitest";
import { nextShopperFundingStep, paySheetUrl } from "@repo/agentcard";
import {
  EARNINGS_ASK,
  RECAP_PAY_ASK,
  SKU_FOUND,
  assignsTravelerBeforeAccept,
  inventsThirtyEarnings,
  PAYMENT_WAIT,
  TRAVELER_OVER_CAP,
  asksForFreshWallet,
  recapBody,
  recapTotalCents,
  shopperAccepted,
  shopperWait,
  taxCentsFor,
} from "@manebra/dialog";
import { listingImageParts } from "@manebra/dialog";

describe("earnings ask", () => {
  it("asks after SKU pick and does not invent $30", () => {
    expect(EARNINGS_ASK).toBe("What’s fair to pay the traveler for this?");
    expect(inventsThirtyEarnings(EARNINGS_ASK)).toBe(false);
  });
});

describe("recap total is item + tax + earnings", () => {
  it("keeps $50 earnings on a $42.99 item plus tax", () => {
    const item = 4299;
    const tax = taxCentsFor({ priceCents: item, storeName: "Apple" });
    const earnings = 5000;
    const total = recapTotalCents(item, tax, earnings);
    expect(total).toBe(item + tax + earnings);
    const body = recapBody({
      title: "AirPods Pro",
      merchant: "Apple",
      itemCents: item,
      taxCents: tax,
      earningsCents: earnings,
    });
    expect(body).toContain("$42.99");
    expect(body).toContain("$50.00");
    expect(assignsTravelerBeforeAccept(body)).toBe(false);
    expect(body).not.toMatch(/pay-sheet|wallet|AgentCard|4242/i);
  });
});

describe("no named traveler before accept", () => {
  it("wait copy never assigns a named traveler", () => {
    const wait = shopperWait("Accra");
    expect(assignsTravelerBeforeAccept(wait)).toBe(false);
    expect(wait).not.toMatch(/\b(Ama|Kofi|Nana)\b/);
    expect(wait).not.toMatch(/pay-sheet|wallet|fund /i);
  });
});

describe("SKU photo is a media part", () => {
  it("sends the product photo, not a text URL", () => {
    const parts = listingImageParts({
      title: "AirPods Pro",
      merchant: "Apple",
      priceCents: 4299,
      imageUrl: "https://store.example/airpods.jpg",
    });
    expect(parts[0]).toMatchObject({ type: "media", url: "https://store.example/airpods.jpg" });
    expect(JSON.stringify(parts)).not.toMatch(/\[.*\]\(https?:/);
  });
});

describe("funding on recap confirm, not at needs_pick", () => {
  it("uses Anvil only in demo when AGENTCARD_* is unset", () => {
    expect(nextShopperFundingStep({ configured: false, hasCard: true, paySheetSent: false })).toBe(
      "unconfigured",
    );
    expect(
      nextShopperFundingStep({ configured: false, hasCard: true, paySheetSent: false, demo: true }),
    ).toBe("anvil");
  });

  it("sends wallet then pay-sheet on recap yes, amount = recap total", () => {
    expect(SKU_FOUND).not.toMatch(/pay sheet/i);
    expect(RECAP_PAY_ASK).toMatch(/pay sheet/i);
    expect(nextShopperFundingStep({ configured: true, hasCard: false, paySheetSent: false })).toBe(
      "wallet",
    );
    expect(nextShopperFundingStep({ configured: true, hasCard: true, paySheetSent: false })).toBe(
      "paysheet",
    );
    const item = 4299;
    const tax = taxCentsFor({ priceCents: item, storeName: "Apple" });
    const total = recapTotalCents(item, tax, 5000);
    const url = paySheetUrl("https://app.agentcard.sh/w/wl_test.token", "Manebra", total);
    expect(new URL(url).searchParams.get("amount")).toBe(String(total));
    expect(shopperAccepted("Accra")).toBe("Someone heading to Accra took it.");
    expect(shopperAccepted("Accra")).not.toMatch(/total to fund|pay sheet/i);
  });

  it("recap yes is a wallet/pay-sheet handoff, not a charge, and login-fail does not ask yes again", () => {
    expect(nextShopperFundingStep({ configured: true, hasCard: false, paySheetSent: false })).toBe(
      "wallet",
    );
    expect(nextShopperFundingStep({ configured: true, hasCard: true, paySheetSent: false })).toBe(
      "paysheet",
    );
    expect(nextShopperFundingStep({ configured: true, hasCard: true, paySheetSent: true })).toBe(
      "wait_payment",
    );
    expect(PAYMENT_WAIT).not.toMatch(/say yes/i);
    expect(asksForFreshWallet("Wallet link expired so send new link")).toBe(true);
    expect(TRAVELER_OVER_CAP).toMatch(/top-up/i);
    const item = 39999;
    const tax = taxCentsFor({ priceCents: item, storeName: "Target" });
    const earn = 5000;
    const recap = recapTotalCents(item, tax, earn);
    expect(recap - earn).toBe(item + tax);
  });
});
