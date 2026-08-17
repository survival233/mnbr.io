// Server-only surface: holds keys, writes to chain, touches db/inngest.
// NEVER import this from client or shared/pure code.
export { settlementConfig } from "./config";
export { attestorClient, settlementPublicClient, signRelease, signRefund } from "./attestor";
export { operatorClient } from "./operator";
export { scheduleEscrowRelease, onReleaseScheduled, refundEscrowForBid } from "./handover-seam";
export { reconcileEscrows, type ReconcileReport, type ReconcileOptions } from "./reconcile";
export type { AgentWallet, WalletProvider, AgentRole } from "./wallets/types";
export { localWalletProvider } from "./wallets/local";
export { cdpWalletProvider } from "./wallets/cdp";
export { authorizeEscrowFunding, SpendRejectedError } from "./wallets/authorize";
export { demoLocalChain, agentWallet, fundLocalEscrow, settleLocalEscrow } from "./local-escrow";
export type { FundLocalResult } from "./local-escrow";
