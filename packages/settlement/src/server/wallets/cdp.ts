/**
 * Coinbase CDP wallet provider — production. Each (userId, role) maps to a named
 * CDP EVM server account: keys are MPC-secured in Coinbase's enclave and never
 * exposed to this process or any LLM context. The account object exposes a
 * viem-compatible signTypedData, which is all settlement needs.
 *
 * Auth: CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET env vars are
 * read by CdpClient automatically. Defense in depth: mirror the spend policy
 * as a CDP server-side account policy (CreatePolicyBodySchema) so caps hold
 * even if this process is compromised — our evaluateSpend runs first, CDP's
 * policy engine backstops it.
 */
import { CdpClient } from "@coinbase/cdp-sdk";
import type { TypedDataDefinition } from "viem";
import type { AgentRole, AgentWallet, WalletProvider } from "./types";

export function cdpWalletProvider(): WalletProvider {
  const cdp = new CdpClient();
  return {
    name: "cdp",
    async getOrCreateWallet(userId: string, role: AgentRole): Promise<AgentWallet> {
      // CDP account names: alphanumeric + hyphens. Stable per (user, role).
      const name = `mnbr-${role.replace("_", "-")}-${userId.replace(/[^a-zA-Z0-9]/g, "")}`.slice(0, 36);
      const account = await cdp.evm.getOrCreateAccount({ name });
      return {
        address: account.address,
        signTypedData: (payload: TypedDataDefinition) =>
          account.signTypedData(payload as Parameters<typeof account.signTypedData>[0]),
      };
    },
  };
}
