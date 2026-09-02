import { describe, expect, it } from "vitest";
import { classifyTurn, type DialogSession } from "@manebra/dialog";
import {
  SKU_FOUND,
  SKU_TOO_FEW,
  listingCaption,
  listingImageParts,
} from "@manebra/dialog";
import { formatShopPickList, listingsForPicker, listingsWithPhotos, type ProductListing } from "@manebra/catalog";

function listing(partial: Partial<ProductListing> & Pick<ProductListing, "listingId" | "storeName" | "storeSlug" | "productTitle" | "priceCents" | "imageUrl">): ProductListing {
  return {
    currency: "USD",
    availability: "in_stock",
    availabilityLabel: "In Stock",
    productUrl: "https://example.com/x",
    shoppingCity: "",
    category: "electronics",
    ...partial,
  };
}

describe("named item → photo SKU cards, no yes-gate", () => {
  const rows = [
    listing({
      listingId: "amazon:1",
      storeName: "Amazon",
      storeSlug: "amazon",
      productTitle: "USB C Charger Block, Costyle 25W Dual Port",
      priceCents: 1599,
      imageUrl: "https://m.media-amazon.com/images/I/charger.jpg",
    }),
    listing({
      listingId: "walmart:1",
      storeName: "Walmart",
      storeSlug: "walmart",
      productTitle: "onn. 20W USB-C Fast Charger",
      priceCents: 899,
      imageUrl: "https://i5.walmartimages.com/charger.jpeg",
    }),
    listing({
      listingId: "target:1",
      storeName: "Target",
      storeSlug: "target",
      productTitle: "heyday USB-C Wall Charger",
      priceCents: 1299,
      imageUrl: "https://target.scene7.com/is/image/charger",
    }),
    listing({
      listingId: "target:flat",
      storeName: "Target",
      storeSlug: "target",
      productTitle: "USB-C Charger",
      priceCents: 39999,
      imageUrl: "",
    }),
  ];

  it("keeps ≥2 image SKUs; picker list still includes a row without a photo", () => {
    const cards = listingsWithPhotos(rows, 4);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.every((c) => listingImageParts({
      title: c.productTitle,
      merchant: c.storeName,
      priceCents: c.priceCents,
      imageUrl: c.imageUrl,
    }).some((p) => p.type === "media"))).toBe(true);
    const picks = listingsForPicker(rows, 4);
    expect(picks.some((c) => c.priceCents === 39999 && !c.imageUrl)).toBe(true);
    for (const c of cards) {
      const caption = listingCaption({
        title: c.productTitle,
        merchant: c.storeName,
        priceCents: c.priceCents,
      });
      expect(caption).toMatch(/ · /);
      expect(caption).not.toBe(`Target 399.99`);
      expect(caption).not.toMatch(/^Target\s+399/);
    }
  });

  it("does not yes-gate catalog search", () => {
    expect(SKU_FOUND).toBe("Pick 1–4, or name the store.");
    expect(SKU_FOUND).not.toMatch(/say yes/i);
    expect(SKU_TOO_FEW).not.toMatch(/say yes/i);
    const s: DialogSession = {
      step: "await_listing",
      pending: {
        slot: "listing",
        proposed: "0",
        kind: "choice",
        prompt: SKU_FOUND,
      },
      listings: cardsAsDialog(rows),
    };
    expect(classifyTurn(s, { text: "yes" }).act).toBe("REASK");
    expect(classifyTurn(s, { text: "1" }).optionIndex).toBe(0);
  });

  it("fallback is a numbered 4-shop list when photos are missing", () => {
    const picks = listingsForPicker(rows, 4);
    expect(picks.length).toBeGreaterThanOrEqual(2);
    expect(picks.length).toBeLessThanOrEqual(4);
    expect(picks.some((c) => !c.imageUrl && c.storeName === "Target")).toBe(true);
    const list = formatShopPickList(picks);
    expect(list).toMatch(/^1\. /);
    expect(list).toMatch(/2\. /);
    expect(list).toMatch(/ · /);
    expect(list).not.toMatch(/got it — searching/i);
    const s: DialogSession = {
      step: "await_listing",
      pending: {
        slot: "listing",
        proposed: null,
        kind: "choice",
        prompt: SKU_FOUND,
      },
      listings: picks.map((l) => ({
        productTitle: l.productTitle,
        storeName: l.storeName,
        priceCents: l.priceCents,
      })),
    };
    expect(classifyTurn(s, { text: "1" }).optionIndex).toBe(0);
    expect(classifyTurn(s, { text: "yes" }).act).toBe("REASK");
  });
});

function cardsAsDialog(rows: ProductListing[]) {
  return listingsWithPhotos(rows, 4).map((l) => ({
    productTitle: l.productTitle,
    storeName: l.storeName,
    priceCents: l.priceCents,
  }));
}
