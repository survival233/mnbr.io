/**
 * Constraint envelope — the principal's signed consent for their agent to
 * negotiate. EIP-712 typed data signed by the principal's AGENT WALLET
 * (WalletProvider from @manebra/settlement), so every negotiation is bound to
 * a verifiable, expiring mandate: WHO authorized WHAT limit on WHICH item/trip.
 * This is the AP2 "intent mandate" pattern, self-hosted.
 *
 * The limit is the ONLY number the agent may not cross:
 *   shopper:  limitFeeCents = MAX traveler fee they'll pay
 *   traveler: limitFeeCents = MIN traveler fee they'll accept
 */
import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from "viem";

export type NegotiationRole = "shopper" | "traveler";

export interface Envelope {
  role: NegotiationRole;
  itemRequestId: string;
  tripId: string;
  limitFeeCents: number;
  /** unix seconds; the mandate — and any negotiation under it — dies at expiry. */
  validUntil: number;
}

export interface SignedEnvelope extends Envelope {
  signer: Address; // the principal's agent wallet
  signature: Hex;
}

export const ENVELOPE_TYPES = {
  NegotiationEnvelope: [
    { name: "role", type: "string" },
    { name: "itemRequestId", type: "string" },
    { name: "tripId", type: "string" },
    { name: "limitFeeCents", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export function envelopeDomain(chainId: number): TypedDataDomain {
  return { name: "ManebraNegotiation", version: "1", chainId };
}

export function buildEnvelopePayload(chainId: number, e: Envelope) {
  return {
    domain: envelopeDomain(chainId),
    types: ENVELOPE_TYPES,
    primaryType: "NegotiationEnvelope" as const,
    message: {
      role: e.role,
      itemRequestId: e.itemRequestId,
      tripId: e.tripId,
      limitFeeCents: BigInt(e.limitFeeCents),
      validUntil: BigInt(e.validUntil),
    },
  };
}

/** True iff `signature` over the envelope recovers to `signer`. */
export async function verifyEnvelope(chainId: number, se: SignedEnvelope): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      ...buildEnvelopePayload(chainId, se),
      signature: se.signature,
    });
    return recovered.toLowerCase() === se.signer.toLowerCase();
  } catch {
    return false;
  }
}
