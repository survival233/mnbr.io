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
  /** When true, priceCents already includes tax — recap must not add tax. */
  includesTax?: boolean;
  currency: string;
  availability: "in_stock" | "pickup_today" | "limited" | "out_of_stock" | "unknown";
  availabilityLabel: string;
  /** The store product page. After selection this is the exact approved-store URL handed to the traveler. */
  productUrl: string;
  /** SerpAPI product id, used to resolve the direct store URL + image at selection. */
  productId?: string;
  /** True once productUrl is confirmed to be a direct approved-store link (not a Google redirect). */
  urlVerified?: boolean;
  imageUrl: string;
  shoppingCity: string;
  category: "electronics" | "clothing_shoes" | "cosmetics_sealed" | "books_media" | "food_sealed_nonperishable";
  color?: string;
  storage?: string;
  size?: string;
  normalizedName?: string;
  variants?: ProductListing[];
}

export interface ProductSearchResult {
  query: string;
  shoppingCity: string;
  identifiedProduct: string | null;
  listings: ProductListing[];
}
