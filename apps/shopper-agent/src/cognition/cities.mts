/** Strict US shopping-city helpers — never treat free chat as a city. */

export {
  US_SHOP_HUBS,
  isCityAdviceQuestion,
  parseUsShoppingCity,
  type UsShopHub,
} from "@manebra/dialog";

export function recommendUsCityBubble(product?: string): string[] {
  const item = product?.trim() ? ` for ${product.trim()}` : "";
  return [
    `For most shopping${item}, New York or Atlanta are strong hubs — more store stock and more travelers on those routes.`,
    `I’d start with New York unless you have a preference. Want me to search near New York, Atlanta, or another city?`,
  ];
}
