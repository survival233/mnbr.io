/**
 * Escrow-state mapping + the pure drift classifier used by the reconciliation job
 * (the settlement-agent monitoring seam). Pure and dependency-free so it can be
 * exhaustively unit-tested; the job wraps it with chain reads and DB writes.
 *
 * The CHAIN is the source of truth. The DB mirror is written from confirmed on-chain
 * events, so the mirror must never LEAD the chain. Reconciliation heals the mirror
 * toward the chain and flags anything that violates that ordering as an anomaly.
 */

/// Mirrors HandoverEscrow.State (uint8) on-chain.
export enum OnChainEscrowState {
  None = 0,
  Opened = 1,
  Funded = 2,
  Released = 3,
  Refunded = 4,
}

/// Mirrors the Prisma EscrowState enum.
export type MirrorEscrowState = "none" | "opened" | "funded" | "released" | "refunded";

const MIRROR_BY_ONCHAIN: Record<OnChainEscrowState, MirrorEscrowState> = {
  [OnChainEscrowState.None]: "none",
  [OnChainEscrowState.Opened]: "opened",
  [OnChainEscrowState.Funded]: "funded",
  [OnChainEscrowState.Released]: "released",
  [OnChainEscrowState.Refunded]: "refunded",
};

export function onChainToMirror(s: OnChainEscrowState | number): MirrorEscrowState {
  const m = MIRROR_BY_ONCHAIN[s as OnChainEscrowState];
  if (!m) throw new Error(`unknown on-chain escrow state: ${s}`);
  return m;
}

/// Progression rank. None→Opened→Funded→terminal. Released and Refunded are
/// sibling terminals (same rank) — neither is "ahead" of the other.
const RANK: Record<MirrorEscrowState, number> = {
  none: 0,
  opened: 1,
  funded: 2,
  released: 3,
  refunded: 3,
};

export function isTerminal(s: MirrorEscrowState): boolean {
  return s === "released" || s === "refunded";
}

export type DriftVerdict =
  | { kind: "in_sync" }
  | { kind: "heal"; from: MirrorEscrowState; to: MirrorEscrowState }
  | {
      kind: "anomaly";
      reason: "mirror_ahead_of_chain" | "terminal_conflict";
      mirror: MirrorEscrowState;
      chain: MirrorEscrowState;
    };

/**
 * Compare the DB mirror against on-chain truth.
 *  - equal                       -> in_sync
 *  - chain strictly ahead        -> heal (update mirror to chain; a missed/late event)
 *  - both terminal but different -> anomaly (terminal_conflict; should be impossible)
 *  - mirror ahead of chain       -> anomaly (mirror_ahead_of_chain; mirror must never lead)
 */
export function classifyDrift(mirror: MirrorEscrowState, chain: MirrorEscrowState): DriftVerdict {
  if (mirror === chain) return { kind: "in_sync" };

  if (isTerminal(mirror) && isTerminal(chain)) {
    return { kind: "anomaly", reason: "terminal_conflict", mirror, chain };
  }
  if (RANK[chain] > RANK[mirror]) {
    return { kind: "heal", from: mirror, to: chain };
  }
  return { kind: "anomaly", reason: "mirror_ahead_of_chain", mirror, chain };
}
