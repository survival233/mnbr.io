/**
 * Shopping catalogs by market. MVP is US Google Shopping via SerpAPI.
 * Add a market here (gl, location country, currency) plus a search adapter —
 * matching and traveler IATA do not change.
 */
import { resolveHub } from "@manebra/geo";

export type ShopMarket = {
  id: string;
  gl: string;
  locationCountry: string;
  currency: string;
  countries: readonly string[];
};

export const SHOP_MARKETS: readonly ShopMarket[] = [
  { id: "us", gl: "us", locationCountry: "United States", currency: "USD", countries: ["US"] },
];

export function shopMarketForCity(city: string): ShopMarket | undefined {
  const t = city.trim();
  if (!t) return undefined;
  if (/^(us|usa|united states)$/i.test(t)) {
    return SHOP_MARKETS.find((m) => m.id === "us");
  }
  const hub = resolveHub(city);
  if (!hub?.country) return undefined;
  return SHOP_MARKETS.find((m) => m.countries.includes(hub.country));
}

export class NoShopMarketError extends Error {
  constructor(public city: string) {
    super(`No shopping catalog wired for ${city}`);
    this.name = "NoShopMarketError";
  }
}
