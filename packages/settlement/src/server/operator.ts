/**
 * Operator wallet — the only key allowed to call HandoverEscrow.open().
 * Distinct from the attestor (release/refund signatures). Relayers for
 * fundWithAuthorization may be anyone (incl. attestor); open is operator-only.
 */
import { createWalletClient, http, type Account, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { settlementConfig } from "./config";

const CHAIN = settlementConfig.chainEnv === "mainnet" ? base : baseSepolia;

function makeOperatorAccount(): Account {
  const key = process.env.OPERATOR_PRIVATE_KEY as Hex | undefined;
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) {
    return privateKeyToAccount(key);
  }
  // Local / smoke fallback: when OPERATOR_PRIVATE_KEY is unset, reuse attestor
  // (Anvil deployments that set OPERATOR==ATTESTOR). Sepolia must set both.
  if (settlementConfig.attestorPrivateKey) {
    return privateKeyToAccount(settlementConfig.attestorPrivateKey);
  }
  throw new Error("OPERATOR_PRIVATE_KEY (or ATTESTOR_PRIVATE_KEY fallback) is required");
}

const operatorAccount = makeOperatorAccount();

export const operatorClient = createWalletClient({
  account: operatorAccount,
  chain: CHAIN,
  transport: http(settlementConfig.rpcUrl),
});
