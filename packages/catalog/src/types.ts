/** One retailer listing for a searched product. */
export interface ProductListing {
  /** Stable id for selection: `{storeSlug}:{sku}` */
  listingId: string;
  storeName: string;
  storeSlug: "apple" | "bestbuy" | "walmart" | "target" | "amazon" | "link";
  productTitle: string;
  priceCents: number;
  /** Catalog tax in cents when SerpAPI includes it; recap estimates otherwise. */
  taxCents?: number;
  currency: string;
  availability: "in_stock" | "pickup_today" | "limited" | "out_of_stock" | "unknown";
  availabilityLabel: string;
  productUrl: string;
  imageUrl: string;
  shoppingCity: string;
  category: "electronics" | "clothing_shoes" | "cosmetics_sealed" | "books_media" | "food_sealed_nonperishable";
}

export interface ProductSearchResult {
  query: string;
  shoppingCity: string;
  identifiedProduct: string | null;
  listings: ProductListing[];
}
