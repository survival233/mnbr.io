/**
 * Commerce SDK purchase turn for the traveler — the Vector C buy, run in place
 * of the legacy `buyWithUserCard` when `COMMERCE_SDK_ENABLED` is on.
 *
 * The traveler buys on their OWN linked card (the buy tool is bound to the
 * traveler's own identity). Product cards, the Vault/approval links and the
 * store sign-in all reach the traveler's Relay chat through `sendLink`; the
 * model never reads a link. We return the model's final reply text so the
 * caller can apply the SAME stock / funded-cap guards the legacy path uses —
 * the held escrow stays the ceiling on what the traveler may spend.
 */
import { chatToolLoop, makeCognitiveLlm } from "@manebra/llm";
import {
  buyInChat,
  bridgeBuyTurn,
  commerceConfigured,
  commerceEnabled,
  type BuyToolLink,
} from "@repo/agentcard/commerce";

/** On when the surface is enabled AND credentials are present. */
export function commerceBuyActive(): boolean {
  return commerceEnabled() && commerceConfigured();
}

const SYSTEM = `You are Manebra's buyer, acting for a TRAVELER who is fulfilling a shopper's already-funded order. You buy on the traveler's own card through the buy tool.
Rules:
- Call the buy tool with the item and store from the request. Show the products the tool returns, then build the cart for the best match.
- Do NOT exceed the funded amount. If the only options cost more, say so plainly and stop — do not confirm.
- Never confirm or place the order on your own. The traveler approves the payment through the approval link the tool sends; your job ends at "ready to approve".
- Replies are chat messages: short, plain text, no markdown, no links (the tool delivers links itself).`;

/** Render one buy-tool link as a short chat line, or null to skip (e.g. a flight card has no page). */
function renderLink(link: BuyToolLink): string | null {
  switch (link.kind) {
    case "vault":
      return link.url ? `Add your card to pay: ${link.url}` : null;
    case "approval":
      return link.url ? `Approve the payment to place the order: ${link.url}` : null;
    case "store_login":
      return link.url ? `Sign in to ${link.store ?? "the store"}: ${link.url}` : null;
    case "product": {
      const head = [link.title, link.price, link.storeDomain ? `(${link.storeDomain})` : null]
        .filter(Boolean)
        .join(" — ");
      if (!link.url) return head || null; // flight option: a card with no page
      return head ? `${head}: ${link.url}` : link.url;
    }
    case "store":
      return link.url ? `${link.title ?? "Store"}: ${link.url}` : null;
    default:
      return null;
  }
}

/**
 * Run one buy turn for the traveler and return the model's reply text (empty on
 * failure, so the caller falls back to its stock/cap handling). Links are posted
 * to the traveler's chat via `say` as they happen. Returns `null` when the
 * commerce path can't run, so the caller uses the legacy buy instead.
 */
export async function commerceBuyReply(args: {
  identity: string;
  chatId: string;
  ask: string;
  say: (text: string) => Promise<void>;
}): Promise<string | null> {
  const cfg = makeCognitiveLlm();
  if (!cfg) return null;
  const tool = buyInChat(args.identity, args.chatId);
  if (!tool) return null;

  const turn = tool.turn(args.ask, {
    sendLink: (link) => {
      const line = renderLink(link);
      if (line) void args.say(line);
    },
  });
  const bridge = bridgeBuyTurn(turn);
  const answer = await chatToolLoop(cfg, {
    system: SYSTEM,
    user: args.ask,
    tools: [bridge.spec],
    callTool: bridge.callTool,
    maxSteps: 10,
  });
  return answer ?? "";
}
