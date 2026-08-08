/** Prohibited-items enforcement — PRD v4.0 §16.2. Allowlist per direction. */
export const TRIP_DIRECTIONS = ["us_to_gh", "gh_to_us"] as const;
export type TripDirection = (typeof TRIP_DIRECTIONS)[number];

export const CATEGORIES_BY_DIRECTION: Readonly<Record<TripDirection, readonly string[]>> = {
  us_to_gh: ["electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable"],
  gh_to_us: ["foodstuffs_cbp_permitted", "textiles_kente", "crafts_nonrestricted"],
};

export const ALWAYS_REVIEW_CATEGORIES: readonly string[] = ["foodstuffs_cbp_permitted"];

export function isCategoryAllowed(direction: TripDirection, category: string): boolean {
  return CATEGORIES_BY_DIRECTION[direction]?.includes(category) ?? false;
}
