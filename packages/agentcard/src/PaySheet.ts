/**
 * Hosted AgentCard pay-sheet (messaging). Not a store checkout.
 * Amount must be the recap total in cents — do not recompute fees here.
 */
import { agentcardConfigured, createWalletLink, paySheetUrl } from "./client";

export type PaySheetArgs = {
  identity: string;
  /** Recap all-in total (cents). Must match quoteLines / offer.totalCents. */
  amountCents: number;
  merchant?: string;
};

export type PaySheetResult = {
  url: string;
  amountCents: number;
  merchant: string;
};

export async function PaySheet(args: PaySheetArgs): Promise<PaySheetResult> {
  if (!agentcardConfigured()) {
    throw new Error("AGENTCARD_* unset");
  }
  const merchant = args.merchant?.trim() || "Manebra";
  const link = await createWalletLink(args.identity);
  return {
    url: paySheetUrl(link.url, merchant, args.amountCents),
    amountCents: args.amountCents,
    merchant,
  };
}

export { paySheetUrl };

/** After traveler accept: wallet if no card, pay-sheet once a card is on file. Never at recap. */
export type ShopperFundingStep = "anvil" | "wallet" | "paysheet" | "wait_payment";

export function nextShopperFundingStep(args: {
  configured: boolean;
  hasCard: boolean;
  paySheetSent: boolean;
}): ShopperFundingStep {
  if (!args.configured) return "anvil";
  if (!args.hasCard) return "wallet";
  if (!args.paySheetSent) return "paysheet";
  return "wait_payment";
}
