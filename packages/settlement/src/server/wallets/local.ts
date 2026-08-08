/**
 * Local wallet provider — dev/sandbox only. Derives a deterministic key per
 * (userId, role) from a server seed via HKDF-like HMAC chaining. Fully
 * functional for the E2E and Base Sepolia sandbox; NEVER for production
 * (production uses an enclave/MPC provider — see cdp.ts).
 */
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, TypedDataDefinition } from "viem";
import type { AgentRole, AgentWallet, WalletProvider } from "./types";

export function localWalletProvider(seed: string): WalletProvider {
  if (!seed || seed.length < 16) throw new Error("localWalletProvider: seed too short");
  return {
    name: "local",
    async getOrCreateWallet(userId: string, role: AgentRole): Promise<AgentWallet> {
      const pk = ("0x" +
        createHmac("sha256", seed).update(`${role}:${userId}`).digest("hex")) as Hex;
      const account = privateKeyToAccount(pk);
      return {
        address: account.address,
        signTypedData: (payload: TypedDataDefinition) => account.signTypedData(payload),
      };
    },
  };
}
