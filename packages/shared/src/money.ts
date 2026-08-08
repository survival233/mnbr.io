/**
 * Money — PRD v4.0 §2.2
 * All amounts are integer minor units (cents). These functions are the ONLY
 * place fee math may live; clients never send computed totals (PRD §6).
 */
export const COMMISSION_RATE_BPS = 1500;
export const BPS_DENOMINATOR = 10_000;
export const MVP_CURRENCY = "USD" as const;

export const NEW_USER_ITEM_CAP_CENTS = 500_00;
export const NEW_USER_MAX_CONCURRENT = 2;
export const NEW_USER_DELIVERY_THRESHOLD = 3;
export const HIGH_VALUE_ITEM_CENTS = 1_000_00;
export const HIGH_VALUE_MIN_TRUST = 120;

export interface FeeBreakdown {
  itemCostCents: number;
  travelerFeeCents: number;
  subtotalCents: number;
  commissionCents: number;
  totalCents: number;
  currency: typeof MVP_CURRENCY;
}

function assertValidCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer number of cents, got ${value}`);
  if (value < 0) throw new RangeError(`${label} must be non-negative, got ${value}`);
}

export function computeFees(itemCostCents: number, travelerFeeCents: number): FeeBreakdown {
  assertValidCents(itemCostCents, "itemCostCents");
  assertValidCents(travelerFeeCents, "travelerFeeCents");
  if (itemCostCents === 0) throw new RangeError("itemCostCents must be greater than zero");
  const subtotalCents = itemCostCents + travelerFeeCents;
  const commissionCents = Math.floor((subtotalCents * COMMISSION_RATE_BPS + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR);
  const totalCents = subtotalCents + commissionCents;
  return { itemCostCents, travelerFeeCents, subtotalCents, commissionCents, totalCents, currency: MVP_CURRENCY };
}

export function formatUsd(cents: number): string {
  assertValidCents(cents, "cents");
  const dollars = Math.floor(cents / 100);
  const rem = (cents % 100).toString().padStart(2, "0");
  return `$${dollars.toLocaleString("en-US")}.${rem}`;
}
