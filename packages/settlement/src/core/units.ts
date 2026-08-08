/**
 * The ONLY place cents (the codebase's canonical money unit) cross into on-chain
 * USDC base units. Mirrors the computeFees invariant: one implementation, unit-tested.
 *
 * USDC has 6 decimals. $1.00 = 100 cents = 1_000_000 base units, so base = cents * 10_000.
 * Cents stay the source of truth everywhere else; conversion happens only at the chain edge.
 */
export const USDC_DECIMALS = 6;
const CENTS_TO_USDC_BASE = 10_000n; // 10^(6-2)

export function centsToUsdc(cents: number | bigint): bigint {
  const c = typeof cents === "bigint" ? cents : BigInt(Math.trunc(cents));
  if (c < 0n) throw new Error("centsToUsdc: negative amount");
  return c * CENTS_TO_USDC_BASE;
}

/** Exact inverse. Throws if the base amount isn't a whole number of cents (guards precision bugs). */
export function usdcToCents(base: bigint): number {
  if (base < 0n) throw new Error("usdcToCents: negative amount");
  if (base % CENTS_TO_USDC_BASE !== 0n) {
    throw new Error("usdcToCents: sub-cent precision would be lost");
  }
  return Number(base / CENTS_TO_USDC_BASE);
}
