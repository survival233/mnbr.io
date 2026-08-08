/**
 * Pure builder for the EIP-3009 ReceiveWithAuthorization typed data that funds
 * the escrow gaslessly. The payer's agent wallet signs this OFFLINE (zero ETH,
 * no approve tx); any relayer submits it via escrow.fundWithAuthorization.
 * Native USDC on Base supports EIP-3009; the domain fields must be read from
 * the token contract (EIP-5267 eip712Domain()), never hardcoded.
 */
import type { Address, Hex, TypedDataDomain } from "viem";

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface FundingAuthorizationInput {
  /** Token EIP-712 domain, read from the token via eip712Domain(). */
  tokenDomain: TypedDataDomain;
  /** The payer (shopper agent wallet). */
  from: Address;
  /** The escrow contract — EIP-3009 enforces payee == submitting contract. */
  escrow: Address;
  /** Exact escrow total (payeeAmount + feeAmount), USDC base units. */
  totalBaseUnits: bigint;
  /** Random 32-byte nonce; single-use, tracked by the token. */
  nonce: Hex;
  /** Unix seconds validity window. */
  validAfter: bigint;
  validBefore: bigint;
}

export function buildFundingAuthorization(input: FundingAuthorizationInput) {
  return {
    domain: input.tokenDomain,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: input.from,
      to: input.escrow,
      value: input.totalBaseUnits,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce,
    },
  };
}
