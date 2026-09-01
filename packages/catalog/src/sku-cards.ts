import type { ProductListing } from "./types.js";

function shortTitle(title: string, max = 48): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 3).trim()}...`;
}

function usd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rem = (cents % 100).toString().padStart(2, "0");
  return `$${dollars.toLocaleString("en-US")}.${rem}`;
}

/** Real SKU cards need a photo URL. Skip text-only merchant+price rows. */
export function listingsWithPhotos(listings: ProductListing[], max = 4): ProductListing[] {
  return listings
    .filter((l) => /^https?:\/\//i.test(l.imageUrl?.trim() ?? "") && l.productTitle.trim() && l.priceCents > 0)
    .slice(0, max);
}

/**
 * Compact SKU list a chat client can turn into horizontal cards:
 * image URL + short title + price + merchant per row.
 */
export function formatSkuCardList(listings: ProductListing[]): string {
  return listings
    .map((l, i) => {
      const title = shortTitle(l.productTitle);
      const price = l.priceCents > 0 ? usd(l.priceCents) : "";
      const img = l.imageUrl?.trim();
      const lines = [`${i + 1}. ${title}`];
      lines.push(price ? `   ${price} · ${l.storeName}` : `   ${l.storeName}`);
      if (img) lines.push(`   ${img}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
