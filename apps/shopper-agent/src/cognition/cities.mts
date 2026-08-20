/** Buy-from town (traveler home) vs shopper town. */

import { parseItem } from "@manebra/dialog";

export {
  US_SHOP_HUBS,
  isCityAdviceQuestion,
  parseUsShoppingCity,
  parseShoppingCity,
  parseDeliveryTown,
  type UsShopHub,
} from "@manebra/dialog";

export function recommendUsCityBubble(product?: string): string[] {
  const item = product?.trim() ? parseItem(product) : null;
  const suffix = item ? ` for ${item}` : "";
  return [
    `Buy-from is the traveler’s home town${suffix}. I can search stores in New York or Atlanta today — that’s the catalog that’s wired.`,
    `Which town should I buy from? New York is usually strongest if you’re using that catalog.`,
  ];
}
