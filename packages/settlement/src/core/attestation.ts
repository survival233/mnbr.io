/**
 * Pure builder for the EIP-712 HandoverAttestation that gates escrow release/refund.
 *
 * This is the on-chain analogue of the existing bid-bound HMAC handover code: a
 * structured, replay-safe, domain-separated message. It lives in @manebra/shared
 * because it is pure and must be identical on the signing side (apps/api) and any
 * verifying/relaying side. It holds NO private key — signing happens in apps/api
 * where the attestor key/KMS lives (see apps/api/src/settlement/attestor.ts).
 *
 * The struct MUST stay byte-identical to HandoverEscrow.sol:
 *   HandoverAttestation(bytes32 escrowId,uint8 action,uint64 deadline)
 *   domain: name="ManebraHandoverEscrow", version="1", chainId, verifyingContract
 */
import type { Address, Hex, TypedDataDomain } from "viem";

export enum AttestationAction {
  Release = 1, // pay traveler (subtotal) + Manebra (commission)
  Refund = 2, // return full total to shopper
}

export const HANDOVER_ATTESTATION_TYPES = {
  HandoverAttestation: [
    { name: "escrowId", type: "bytes32" },
    { name: "action", type: "uint8" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function escrowDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: "ManebraHandoverEscrow", version: "1", chainId, verifyingContract };
}

export interface HandoverAttestationInput {
  /** bytes32 == the bid id, so the attestation is bound to exactly one bid/escrow. */
  escrowId: Hex;
  action: AttestationAction;
  /** unix seconds; the attestation is invalid on-chain after this. Keep short (minutes). */
  deadline: bigint;
}

/** Returns the exact typed-data payload to hand to a signer (viem signTypedData / KMS). */
export function buildHandoverAttestation(
  chainId: number,
  verifyingContract: Address,
  input: HandoverAttestationInput,
) {
  return {
    domain: escrowDomain(chainId, verifyingContract),
    types: HANDOVER_ATTESTATION_TYPES,
    primaryType: "HandoverAttestation" as const,
    message: {
      escrowId: input.escrowId,
      action: input.action,
      deadline: input.deadline,
    },
  };
}
