import { describe, expect, it } from "vitest";
import { formatUsd } from "@manebra/shared";
import {
  EARNINGS_ASK,
  SKU_FOUND,
  SKU_TOO_FEW,
  assignsTravelerBeforeAccept,
  inventsThirtyEarnings,
  listingCaption,
  listingImageParts,
  recapBody,
  recapTotalCents,
  shopperAccepted,
  shopperNobody,
  shopperWait,
  taxCentsFor,
  travelerAsk,
} from "./guest-copy";

describe("earnings ask", () => {
  it("asks for traveler earnings and does not invent $30", () => {
    expect(EARNINGS_ASK).toBe("What’s fair to pay the traveler for this?");
    expect(inventsThirtyEarnings(EARNINGS_ASK)).toBe(false);
    expect(EARNINGS_ASK).not.toMatch(/\$30/);
  });
});

describe("SKU catalog copy", () => {
  it("is one human line, not a searching interpolator or yes-gate", () => {
    expect(SKU_FOUND).toBe("Found a few — any of these, or want me to narrow?");
    expect(SKU_FOUND).not.toMatch(/searching/i);
    expect(SKU_FOUND).not.toMatch(/say yes/i);
    expect(SKU_TOO_FEW).not.toMatch(/say yes/i);
  });
});

describe("recap total", () => {
  it("keeps $50 earnings on a $42.99 item plus tax", () => {
    const item = 4299;
    const tax = taxCentsFor({ priceCents: item, storeName: "Apple" });
    const earnings = 5000;
    const total = recapTotalCents(item, tax, earnings);
    expect(tax).toBe(Math.round((4299 * 875) / 10_000));
    expect(total).toBe(item + tax + earnings);
    const body = recapBody({
      title: "AirPods Pro",
      merchant: "Apple",
      itemCents: item,
      taxCents: tax,
      earningsCents: earnings,
    });
    expect(body).toContain(`Item ${formatUsd(item)}`);
    expect(body).toContain(`Tax ${formatUsd(tax)}`);
    expect(body).toContain(`Traveler ${formatUsd(earnings)}`);
    expect(body).toContain(`Total ${formatUsd(total)}`);
    expect(body).toContain("$42.99");
    expect(body).toContain("$50.00");
    expect(assignsTravelerBeforeAccept(body)).toBe(false);
  });

  it("uses catalog tax when present instead of the merchant estimate", () => {
    expect(taxCentsFor({ priceCents: 4299, taxCents: 344, storeName: "Apple" })).toBe(344);
  });
});

describe("no named traveler before accept", () => {
  it("flags assignment copy and keeps wait/nobody/accepted anonymous", () => {
    expect(assignsTravelerBeforeAccept("I’ll send this to Ama heading your way")).toBe(true);
    const wait = shopperWait("Accra");
    const nobody = shopperNobody("Accra");
    const accepted = shopperAccepted("Accra", 4299 + 376 + 5000);
    for (const line of [wait, nobody, accepted]) {
      expect(assignsTravelerBeforeAccept(line)).toBe(false);
      expect(line).not.toMatch(/\b(Ama|Kofi|Nana)\b/);
      expect(line).not.toMatch(/\bACC\b/);
      expect(inventsThirtyEarnings(line)).toBe(false);
    }
    expect(wait).toContain("I’ll ask travelers already heading to Accra");
    expect(nobody).toContain("I’ll keep it up");
    expect(accepted).toContain("Someone heading to Accra took it");
  });
});

describe("listing image parts", () => {
  it("sends the photo as a media part, not a markdown URL", () => {
    const parts = listingImageParts({
      title: "AirPods Pro",
      merchant: "Apple",
      priceCents: 4299,
      imageUrl: "https://store.example/airpods.jpg",
    });
    expect(parts[0]).toEqual({
      type: "media",
      url: "https://store.example/airpods.jpg",
      media_kind: "image",
      content_type: "image/jpeg",
    });
    expect(parts[1]).toEqual({
      type: "text",
      text: listingCaption({ title: "AirPods Pro", merchant: "Apple", priceCents: 4299 }),
    });
    expect(JSON.stringify(parts)).not.toMatch(/\[.*\]\(https?:/);
  });

  it("skips a SKU with no product photo instead of a text-only row", () => {
    expect(
      listingImageParts({
        title: "USB-C Charger",
        merchant: "Target",
        priceCents: 39999,
        imageUrl: "",
      }),
    ).toEqual([]);
  });
});

describe("traveler ask", () => {
  it("uses trip, item, merchant, price, and earnings", () => {
    const lines = travelerAsk({
      city: "Accra",
      title: "AirPods Pro",
      merchant: "Apple",
      itemCents: 4299,
      earningsCents: 5000,
    });
    expect(lines.join("\n")).toBe(
      [
        "You’re going to Accra.",
        "Someone needs AirPods Pro (Apple, $42.99).",
        "Traveler earnings $50.00.",
        "Want it?",
      ].join("\n"),
    );
    expect(lines.join(" ")).not.toMatch(/\b(Ama|Kofi|Nana)\b/);
  });
});
