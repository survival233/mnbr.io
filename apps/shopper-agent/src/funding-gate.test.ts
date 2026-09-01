import { describe, expect, it } from "vitest";
import { nextShopperFundingStep, paySheetUrl } from "@repo/agentcard";
import {
  EARNINGS_ASK,
  assignsTravelerBeforeAccept,
  inventsThirtyEarnings,
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

describe("funding after traveler accept", () => {
  it("uses Anvil when AGENTCARD_* is unset", () => {
    expect(nextShopperFundingStep({ configured: false, hasCard: true, paySheetSent: false })).toBe(
      "anvil",
    );
  });

  it("sends wallet then pay-sheet only after accept, amount = recap total", () => {
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
    expect(shopperAccepted("Accra", total)).toContain("Total to fund is");
  });
});
