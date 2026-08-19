/** Strict US shopping-city helpers — never treat free chat as a city. */

import { parseItem } from "@manebra/dialog";

export {
  US_SHOP_HUBS,
  isCityAdviceQuestion,
  parseUsShoppingCity,
  type UsShopHub,
} from "@manebra/dialog";

export function recommendUsCityBubble(product?: string): string[] {
  const item = product?.trim() ? parseItem(product) : null;
  const suffix = item ? ` for ${item}` : "";
  return [
    `For most shopping${suffix}, New York or Atlanta are strong hubs — more store stock and more travelers on those routes.`,
    `I’d start with New York unless you have a preference. Want me to search near New York, Atlanta, or another city?`,
  ];
}
