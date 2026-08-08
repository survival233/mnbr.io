/** Wallet provider factory: local (dev/sandbox) or CDP (production, MPC enclave). */
import { localWalletProvider, cdpWalletProvider, type WalletProvider } from "@manebra/settlement/server";

let provider: WalletProvider | null = null;

export function getWalletProvider(): WalletProvider {
  if (provider) return provider;
  if (process.env.WALLET_PROVIDER === "cdp") {
    provider = cdpWalletProvider();
  } else {
    const seed = process.env.LOCAL_WALLET_SEED;
    if (!seed) throw new Error("LOCAL_WALLET_SEED is not set (or set WALLET_PROVIDER=cdp)");
    provider = localWalletProvider(seed);
  }
  return provider;
}
