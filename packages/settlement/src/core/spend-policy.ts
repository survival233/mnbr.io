/**
 * Spend policy — the pure guardrail kernel for agent wallets.
 * "Agents propose, guardrails dispose": an agent may ASK to authorize a spend,
 * but the policy is evaluated BEFORE any signature is produced. No signature,
 * no money movement — an over-cap or off-allowlist request never becomes valid.
 *
 * Pure and dependency-free so it is exhaustively testable and identical across
 * providers (local, CDP, Privy). Providers additionally enforce their own
 * server-side caps (defense in depth); this is the layer we control and test.
 */
import type { Address } from "viem";

export interface SpendPolicy {
  /** Hard cap per single authorization, in USDC base units (6 dp). */
  maxPerTxBaseUnits: bigint;
  /** Rolling daily cap, in USDC base units. */
  dailyCapBaseUnits: bigint;
  /** Contracts this wallet may authorize value toward (e.g. [escrowAddress]). */
  allowedContracts: readonly Address[];
}

export interface SpendRequest {
  /** The contract that will receive/pull the value (the escrow). */
  to: Address;
  amountBaseUnits: bigint;
}

export interface SpendWindow {
  /** Sum of already-authorized spends in the current 24h window. */
  spentTodayBaseUnits: bigint;
}

export type SpendVerdict =
  | { allowed: true }
  | { allowed: false; reason: "non_positive_amount" | "over_tx_cap" | "over_daily_cap" | "contract_not_allowed" };

export function evaluateSpend(policy: SpendPolicy, req: SpendRequest, window: SpendWindow): SpendVerdict {
  if (req.amountBaseUnits <= 0n) return { allowed: false, reason: "non_positive_amount" };
  const to = req.to.toLowerCase();
  if (!policy.allowedContracts.some((c) => c.toLowerCase() === to)) {
    return { allowed: false, reason: "contract_not_allowed" };
  }
  if (req.amountBaseUnits > policy.maxPerTxBaseUnits) return { allowed: false, reason: "over_tx_cap" };
  if (window.spentTodayBaseUnits + req.amountBaseUnits > policy.dailyCapBaseUnits) {
    return { allowed: false, reason: "over_daily_cap" };
  }
  return { allowed: true };
}
