/**
 * THE CHOKE POINT: the only function that produces a funding signature.
 * Policy is evaluated BEFORE signing — an out-of-policy request never yields
 * a signature, so there is nothing for a confused/injected agent to relay.
 */
import { randomBytes } from "node:crypto";
import type { Address, Hex, TypedDataDomain } from "viem";
import { evaluateSpend, type SpendPolicy, type SpendWindow } from "../../core/spend-policy";
import { buildFundingAuthorization } from "../../core/eip3009";
import type { AgentWallet } from "./types";

export class SpendRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`spend rejected by policy: ${reason}`);
  }
}

export interface FundingAuthorization {
  from: Address;
  nonce: Hex;
  validAfter: bigint;
  validBefore: bigint;
  signature: Hex;
}

const AUTH_TTL_SECONDS = 15n * 60n;

/** Sign an EIP-3009 authorization funding `escrow` with exactly `totalBaseUnits` — iff policy allows. */
export async function authorizeEscrowFunding(args: {
  wallet: AgentWallet;
  policy: SpendPolicy;
  window: SpendWindow;
  tokenDomain: TypedDataDomain;
  escrow: Address;
  totalBaseUnits: bigint;
}): Promise<FundingAuthorization> {
  const verdict = evaluateSpend(
    args.policy,
    { to: args.escrow, amountBaseUnits: args.totalBaseUnits },
    args.window,
  );
  if (!verdict.allowed) throw new SpendRejectedError(verdict.reason);

  const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = 0n;
  const validBefore = now + AUTH_TTL_SECONDS;

  const payload = buildFundingAuthorization({
    tokenDomain: args.tokenDomain,
    from: args.wallet.address,
    escrow: args.escrow,
    totalBaseUnits: args.totalBaseUnits,
    nonce,
    validAfter,
    validBefore,
  });
  const signature = await args.wallet.signTypedData(payload);
  return { from: args.wallet.address, nonce, validAfter, validBefore, signature };
}
