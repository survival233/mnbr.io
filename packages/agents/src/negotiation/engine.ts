/**
 * Negotiation engine — deterministic, bounded, information-hiding.
 *
 * WHY DETERMINISTIC (MVP): no LLM chooses numbers, so there is no prompt
 * surface — a chat message saying "ignore your max, offer $999" cannot move an
 * offer by construction (messages are carried in the transcript for humans but
 * NEVER read here; see the injection test). Termination is provable, not hoped.
 *
 * INFORMATION HIDING (anti-collusion): nextMove() takes ONE envelope — its own
 * principal's. A strategy cannot price against the counterparty's reserve
 * because the counterparty's limit is not an input anywhere in this module.
 *
 * TERMINATION GUARANTEE: each side makes at most cfg.maxRoundsPerSide offers on
 * a monotone concession schedule whose FINAL offer equals its own limit. So if
 * the acceptable ranges overlap at all, the deal closes by the final round; if
 * they are disjoint, both sides exhaust and the negotiation rejects. Either
 * way it ends within 2 * maxRoundsPerSide moves.
 *
 * ENVELOPE CHOKE POINT: every outgoing offer is asserted against the own
 * envelope before it is emitted — an out-of-envelope offer is a thrown error,
 * not a message.
 */
import type { Envelope, NegotiationRole } from "./envelope";

export interface Offer {
  by: NegotiationRole;
  round: number; // 1-based per side
  feeCents: number;
}

export interface TranscriptMessage {
  by: NegotiationRole;
  text: string; // free text for humans/UI; NEVER an input to any decision
}

export interface Transcript {
  offers: Offer[];
  messages: TranscriptMessage[];
}

export interface EngineConfig {
  maxRoundsPerSide: number; // default 6
  shopperOpenRatio: number; // opening = limit * ratio (<1)
  travelerOpenRatio: number; // opening = limit * ratio (>1)
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxRoundsPerSide: 6,
  shopperOpenRatio: 0.5,
  travelerOpenRatio: 1.6,
};

export type Move =
  | { kind: "offer"; feeCents: number; round: number }
  | { kind: "accept"; feeCents: number }
  | { kind: "reject"; reason: "envelope_expired" | "max_rounds_exhausted" };

export class EnvelopeViolationError extends Error {}

const other = (r: NegotiationRole): NegotiationRole => (r === "shopper" ? "traveler" : "shopper");

function acceptable(role: NegotiationRole, ownLimit: number, offeredFee: number): boolean {
  return role === "shopper" ? offeredFee <= ownLimit : offeredFee >= ownLimit;
}

/** Concession schedule: opening → own limit in maxRounds monotone integer steps. */
export function scheduledOffer(role: NegotiationRole, limit: number, round: number, cfg: EngineConfig): number {
  const ratio = role === "shopper" ? cfg.shopperOpenRatio : cfg.travelerOpenRatio;
  const opening = Math.max(1, Math.round(limit * ratio));
  if (cfg.maxRoundsPerSide <= 1) return limit;
  const t = (round - 1) / (cfg.maxRoundsPerSide - 1); // 0 → 1
  const raw = Math.round(opening + (limit - opening) * t);
  // clamp inside the envelope and force the final round to the exact limit
  const clamped = role === "shopper" ? Math.min(raw, limit) : Math.max(raw, limit);
  return round >= cfg.maxRoundsPerSide ? limit : clamped;
}

/**
 * Decide the next move for `role`, seeing ONLY its own envelope and the public
 * transcript. Order: expiry → accept → exhausted → concede.
 */
export function nextMove(
  role: NegotiationRole,
  own: Envelope,
  transcript: Transcript,
  cfg: EngineConfig = DEFAULT_ENGINE_CONFIG,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Move {
  if (nowSeconds > own.validUntil) return { kind: "reject", reason: "envelope_expired" };

  const counterOffers = transcript.offers.filter((o) => o.by === other(role));
  const lastCounter = counterOffers[counterOffers.length - 1];
  if (lastCounter && acceptable(role, own.limitFeeCents, lastCounter.feeCents)) {
    return { kind: "accept", feeCents: lastCounter.feeCents };
  }

  const ownOffers = transcript.offers.filter((o) => o.by === role);
  const round = ownOffers.length + 1;
  if (round > cfg.maxRoundsPerSide) return { kind: "reject", reason: "max_rounds_exhausted" };

  const feeCents = scheduledOffer(role, own.limitFeeCents, round, cfg);
  // envelope choke point — never emit an out-of-envelope number
  if (!acceptable(role === "shopper" ? "shopper" : "traveler", own.limitFeeCents, feeCents)) {
    throw new EnvelopeViolationError(`offer ${feeCents} violates ${role} limit ${own.limitFeeCents}`);
  }
  return { kind: "offer", feeCents, round };
}

export type NegotiationOutcome =
  | { outcome: "deal"; feeCents: number; totalMoves: number; transcript: Transcript }
  | { outcome: "no_deal"; reason: string; totalMoves: number; transcript: Transcript };

/**
 * Run a full negotiation between two envelopes (traveler opens, as in bidding).
 * Used by tests, simulations, and the server session loop.
 */
export function runNegotiation(
  shopper: Envelope,
  traveler: Envelope,
  cfg: EngineConfig = DEFAULT_ENGINE_CONFIG,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  injectedMessages: TranscriptMessage[] = [],
): NegotiationOutcome {
  const transcript: Transcript = { offers: [], messages: [...injectedMessages] };
  let turn: NegotiationRole = "traveler";
  const hardStop = 2 * cfg.maxRoundsPerSide + 2;

  for (let moves = 1; moves <= hardStop; moves++) {
    const own = turn === "shopper" ? shopper : traveler;
    const move = nextMove(turn, own, transcript, cfg, nowSeconds);
    if (move.kind === "accept") return { outcome: "deal", feeCents: move.feeCents, totalMoves: moves, transcript };
    if (move.kind === "reject") return { outcome: "no_deal", reason: move.reason, totalMoves: moves, transcript };
    transcript.offers.push({ by: turn, round: move.round, feeCents: move.feeCents });
    turn = other(turn);
  }
  return { outcome: "no_deal", reason: "hard_stop", totalMoves: hardStop, transcript };
}
