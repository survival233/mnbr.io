/**
 * One long-running listener per company + mode. Call it once when a Manebra
 * agent (shopper or traveler) boots. The agent holds one open connection to
 * Agentcard, so there is no public webhook URL and no signature to check.
 *
 * `onMessage` fires with our own id for the actor and a ready-to-post text
 * ("card saved", "order placed", "on its way"). Post it into that actor's Relay
 * chat; the client then keeps it for the actor's next `buy.turn`, which hands it
 * to the model via `turn.messages(history)` so the model knows what the actor
 * read between turns. `onEvent` catches order events (`order.placed`,
 * `order.confirmed`, `order.failed`, `order.updated`) — the hooks Vector C uses
 * to reconcile a purchase against the held escrow amount.
 */
import type { AgentcardClient } from "@agent-cards/commerce-sdk";

export type CommerceListenHandlers = {
  onMessage?: (actorId: string, text: string, threadId: string | null) => void | Promise<void>;
  onOrderEvent?: (type: string, data: Record<string, unknown>) => void | Promise<void>;
};

/** Start the Commerce SDK listener on the shared client; null when unconfigured. */
export function startCommerceListener(
  agentcard: AgentcardClient | null,
  handlers: CommerceListenHandlers,
) {
  if (!agentcard) return null;
  return agentcard.listen({
    onMessage: (actorId, message) =>
      handlers.onMessage?.(actorId, message.text, message.threadId ?? null),
    onEvent: (event) => {
      if (event.type.startsWith("order.")) {
        void handlers.onOrderEvent?.(event.type, (event.data ?? {}) as Record<string, unknown>);
      }
    },
  });
}
