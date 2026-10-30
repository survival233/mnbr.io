/**
 * One buy tool per actor, built on the first message and kept for the rest.
 *
 * In Manebra the "actor" that holds a buy tool is the TRAVELER — not the
 * shopper — and it buys on the TRAVELER'S OWN linked card (their own payment
 * system), never a Manebra-issued card. The shopper's funds sit held in escrow
 * as the reimbursement budget; the traveler's agent uses this tool to place the
 * order at the source-country store, and the order events reconcile against the
 * held amount (see `vector-c.ts`). The same tool, bound to the same traveler,
 * also books the traveler's own flights (the SDK's flight purchase kind) on that
 * same card — alongside Manebra's native flight search/book in `@manebra/flights`.
 * `externalUserId` is our stable id for the actor, `threadId` the Relay
 * conversation the purchase belongs to.
 *
 * Agentcard refuses a call when two actors share one `externalUserId`, so these
 * ids must be stable and unique per person.
 */
import { buyTool, type BuyTool, type BuyToolLink, type BuyDeliveryAddress } from "@agent-cards/commerce-sdk";
import { commerceClient } from "./client";

export type { BuyTool, BuyToolLink, BuyDeliveryAddress };

/** Options shared by every buy tool we build. */
export type BuildBuyOptions = {
  /** Where the order ships — the traveler's local address/hotel for Vector C. */
  deliveryAddress?: BuyDeliveryAddress;
  /** Delivers every link (Vault, approval, store, product) to the actor's chat. */
  sendLink?: (link: BuyToolLink) => void | Promise<void>;
};

const perActor = new Map<string, BuyTool>();
const perThread = new Map<string, BuyTool>();

/** The buy tool for one actor across all their chats (single-chat apps). */
export function buyFor(actorId: string, opts: BuildBuyOptions = {}): BuyTool | null {
  const agentcard = commerceClient();
  if (!agentcard) return null;
  let tool = perActor.get(actorId);
  if (!tool) {
    tool = buyTool({ agentcard, externalUserId: actorId, ...opts });
    perActor.set(actorId, tool);
  }
  return tool;
}

/**
 * The buy tool for one actor in one Relay chat. Agentcard keeps a purchase per
 * thread, so a cart, question or approval never leaks between conversations.
 */
export function buyInChat(actorId: string, chatId: string, opts: BuildBuyOptions = {}): BuyTool | null {
  const agentcard = commerceClient();
  if (!agentcard) return null;
  const key = JSON.stringify([actorId, chatId]);
  let tool = perThread.get(key);
  if (!tool) {
    tool = buyTool({ agentcard, externalUserId: actorId, threadId: chatId, ...opts });
    perThread.set(key, tool);
  }
  return tool;
}

/** Drop cached tools — tests and actor re-link only. */
export function resetBuyTools(): void {
  perActor.clear();
  perThread.clear();
}
