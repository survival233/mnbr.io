/**
 * Agent-wallet provider abstraction. One wallet per (user, role) pair — the
 * shopper's agent and the traveler's agent each get their own address.
 *
 * The interface is deliberately tiny: an address plus typed-data signing.
 * That's ALL settlement needs — funding is an offline EIP-3009 signature
 * (relayed by us), release goes to the traveler's address with no signature
 * required from them. No provider ever exposes a private key, and no signing
 * happens without a spend-policy verdict first (see authorize.ts).
 */
import type { Address, Hex, TypedDataDefinition } from "viem";

export type AgentRole = "shopper_agent" | "traveler_agent";

export interface AgentWallet {
  address: Address;
  /** viem-compatible typed-data signing. Keys live with the provider (enclave/MPC), never here. */
  signTypedData(payload: TypedDataDefinition): Promise<Hex>;
}

export interface WalletProvider {
  readonly name: "local" | "cdp";
  /** Deterministic per (userId, role): the same pair always maps to the same wallet. */
  getOrCreateWallet(userId: string, role: AgentRole): Promise<AgentWallet>;
}
