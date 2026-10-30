/** Both Relay consumers observe every event and make the same routing decision. */
export type AgentRole = "shopper" | "traveler";
export function relayRoute(event: any, text: string, active?: AgentRole, directRole: AgentRole = "shopper", sharedChatIds: string[] = []): { role: AgentRole; text: string } | null {
  const data = event?.data ?? event;
  const msg = data.message ?? data;
  const sender = data.sender_handle ?? msg.sender_handle ?? msg.sender;
  if (["agent", "bot"].includes(String(sender?.type ?? sender?.kind ?? "").toLowerCase()) || sender?.is_bot === true || msg.direction === "outbound") return null;
  const addressed = text.match(/^\s*(?:@(shopper|shopping(?: agent)?|travell?er(?: agent)?)\b[,:\s-]*|(shopper|shopping agent|travell?er(?: agent)?)(?:\s*[:,]\s*|\s*$))/i);
  if (addressed) return { role: /^shop/i.test((addressed[1] ?? addressed[2])!) ? "shopper" : "traveler", text: text.slice(addressed[0].length).trim() || "hi" };
  const chat = data.chat ?? msg.chat ?? {};
  const chatId = String(chat.id ?? msg.conversation_id ?? msg.chat_id ?? "");
  const group = chat.type === "group" || chat.kind === "group" || chat.is_group === true || (Array.isArray(chat.participants) && chat.participants.length > 2) || sharedChatIds.includes(chatId);
  if (!group) return { role: directRole, text };
  // A conversation stays with its selected agent until explicitly switched.
  return { role: active ?? (/\b(flight|flying|travel|travelling|traveling|book a flight)\b/i.test(text) ? "traveler" : "shopper"), text };
}

/** Optional durable storage keeps group follow-ups with their agent after restart. */
export class RelayRoutingState {
  private roles = new Map<string, AgentRole>();
  constructor(private storage?: { load(): Record<string, AgentRole>; save(roles: Record<string, AgentRole>): void }) {
    if (storage) {
      for (const [key, role] of Object.entries(storage.load() ?? {})) {
        if (role === "shopper" || role === "traveler") this.roles.set(key, role);
      }
    }
  }
  route(event: unknown, text: string, conversationId: string, userId: string, directRole: AgentRole, sharedChatIds: string[]) {
    const key = JSON.stringify([conversationId, userId]);
    const route = relayRoute(event, text, this.roles.get(key), directRole, sharedChatIds);
    if (route && this.roles.get(key) !== route.role) {
      this.roles.set(key, route.role);
      if (this.roles.size > 5000) this.roles.delete(this.roles.keys().next().value!);
      this.storage?.save(Object.fromEntries(this.roles));
    }
    return route;
  }
}
