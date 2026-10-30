/**
 * Commerce SDK surface — the THIRD, independent Agentcard surface in this
 * package (alongside the legacy pay-sheet and the per-user card MCP). It gives
 * the traveler a buy tool that places the real order after escrow holds funds
 * (Vector C). Off by default; see `flags.ts`.
 */
export { commerceEnabled, commerceSandbox } from "./flags";
export { commerceClient, commerceConfigured, resetCommerceClient } from "./client";
export { buyFor, buyInChat, resetBuyTools } from "./buy";
export type { BuildBuyOptions, BuyTool, BuyToolLink, BuyDeliveryAddress } from "./buy";
export { bridgeBuyTurn } from "./adapter";
export type { BuyToolBridge, LlmToolSpecLike } from "./adapter";
export { findMerchant, isPayable } from "./merchants";
export type { Merchant, MerchantSupportReason, FindMerchantOptions } from "./merchants";
export { startCommerceListener } from "./listen";
export type { CommerceListenHandlers } from "./listen";
export {
  reconcileOrderTotal,
  orderFromEvent,
  handleConfirmedOrder,
} from "./vector-c";
export type { ReconcileVerdict, ReconcileStatus, ConfirmedOrder, VectorCPorts } from "./vector-c";
