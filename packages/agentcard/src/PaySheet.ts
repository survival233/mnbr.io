/**
 * Hosted AgentCard pay-sheet (messaging). Not a store checkout.
 * Amount must be the recap total in cents — do not recompute fees here.
 */
import { agentcardConfigured, createPaySheetLink, paySheetUrl } from "./client";

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
  const link = await createPaySheetLink(args.identity, merchant, args.amountCents);
  return {
    url: link.url,
    amountCents: args.amountCents,
    merchant,
  };
}

export { paySheetUrl };

/** After recap confirm: wallet if no card, pay-sheet once a card is on file. Anvil only in demo. */
export type ShopperFundingStep = "anvil" | "wallet" | "paysheet" | "wait_payment" | "unconfigured";

export function nextShopperFundingStep(args: {
  configured: boolean;
  hasCard: boolean;
  paySheetSent: boolean;
  demo?: boolean;
}): ShopperFundingStep {
  if (!args.configured) return args.demo ? "anvil" : "unconfigured";
  if (!args.hasCard) return "wallet";
  if (!args.paySheetSent) return "paysheet";
  return "wait_payment";
}
