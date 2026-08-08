/**
 * The ONE canonical mapping from a bid id to its on-chain escrow id.
 *
 * escrowId == keccak256(utf8Bytes(bidId)). Both the open() call and every
 * release/refund attestation must derive the id this exact way, or an attestation
 * signed for a bid won't match its escrow. Collision-resistant, so it's safe for
 * cuid/uuid bid ids of any length (raw byte-truncation would risk collisions).
 *
 * Same discipline as computeFees / centsToUsdc: a single implementation, unit-tested.
 */
import { keccak256, stringToBytes, type Hex } from "viem";

export function bidIdToEscrowId(bidId: string): Hex {
  if (!bidId) throw new Error("bidIdToEscrowId: empty bid id");
  return keccak256(stringToBytes(bidId));
}
