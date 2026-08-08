/**
 * The attestor: the only component that turns a verified handover into an on-chain
 * release/refund signature. The signing key lives HERE (apps/api), never in
 * @manebra/shared and never in anything the LLM/agents can read — same discipline
 * as "client secrets and handover-code plaintexts are never persisted / exposed".
 *
 * MVP: a local private key from validated config. Production: set ATTESTOR_KMS_KEY_ID
 * and construct a KMS/HSM-backed viem account below — callers don't change, because
 * the interface is just "sign this typed data".
 */
import { createWalletClient, createPublicClient, http, type Account, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import {
  AttestationAction,
  buildHandoverAttestation,
} from "../core/attestation";
import { settlementConfig } from "./config";

const CHAIN = settlementConfig.chainEnv === "mainnet" ? base : baseSepolia;

function makeAttestorAccount(): Account {
  if (settlementConfig.attestorPrivateKey) {
    return privateKeyToAccount(settlementConfig.attestorPrivateKey);
  }
  // TODO(prod): return a KMS-backed account built from settlementConfig.attestorKmsKeyId
  // (e.g. an AWS KMS -> viem account adapter). Same Account interface, no caller changes.
  throw new Error("KMS attestor not wired yet; set ATTESTOR_PRIVATE_KEY for the MVP");
}

const attestorAccount = makeAttestorAccount();

export const attestorClient = createWalletClient({
  account: attestorAccount,
  chain: CHAIN,
  transport: http(settlementConfig.rpcUrl),
});

/** Read-only client on the same chain/RPC (contract reads, receipts). */
export const settlementPublicClient = createPublicClient({
  chain: CHAIN,
  transport: http(settlementConfig.rpcUrl),
});

/** Keep attestation lifetimes short — they authorize a fund movement. */
const ATTESTATION_TTL_SECONDS = 15 * 60;

async function sign(escrowId: Hex, action: AttestationAction) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + ATTESTATION_TTL_SECONDS);
  const payload = buildHandoverAttestation(CHAIN.id, settlementConfig.escrowAddress, {
    escrowId,
    action,
    deadline,
  });
  const signature = await attestorAccount.signTypedData!(payload);
  return { escrowId, action, deadline, signature };
}

export const signRelease = (escrowId: Hex) => sign(escrowId, AttestationAction.Release);
export const signRefund = (escrowId: Hex) => sign(escrowId, AttestationAction.Refund);
