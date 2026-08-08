/**
 * Short-lived in-process cache so a shopper can select a listingId from search
 * results a few minutes later without re-querying.
 */
import type { ProductListing } from "./types.js";

const TTL_MS = 30 * 60_000;
const byId = new Map<string, { listing: ProductListing; expiresAt: number }>();

export function cacheListings(listings: ProductListing[]): void {
  const expiresAt = Date.now() + TTL_MS;
  for (const listing of listings) {
    byId.set(listing.listingId, { listing, expiresAt });
  }
}

export function getCachedListing(listingId: string): ProductListing | null {
  const row = byId.get(listingId);
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    byId.delete(listingId);
    return null;
  }
  return row.listing;
}

export function listingIdFor(storeSlug: string, productUrl: string): string {
  // Stable enough within a session; URL uniquely identifies the offer
  const raw = `${storeSlug}:${productUrl}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  return `${storeSlug}:${(h >>> 0).toString(16)}`;
}
