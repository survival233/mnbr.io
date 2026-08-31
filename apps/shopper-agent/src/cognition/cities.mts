/** Buy-from place (shopper preference: city or country) vs handover town. */

import { SHOP_PLACE_ASK } from "@manebra/dialog";

export {
  US_SHOP_HUBS,
  isCityAdviceQuestion,
  parseUsShoppingCity,
  parseShoppingCity,
  parseShopPlace,
  parseDeliveryTown,
  type UsShopHub,
} from "@manebra/dialog";

export function recommendUsCityBubble(_product?: string): string[] {
  return [SHOP_PLACE_ASK];
}
