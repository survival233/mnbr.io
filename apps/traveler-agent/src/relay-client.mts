import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Relay API for the traveler agent.
 * Uses RELAY_TRAVELER_AGENT_TOKEN if set, else RELAY_AGENT_TOKEN
 * (deploy as a separate Relay agent with its own token).
 */
const BASE = process.env.RELAY_API_URL ?? "https://api.relayapp.im";

function token(): string {
  const t = process.env.RELAY_TRAVELER_AGENT_TOKEN?.trim() || process.env.RELAY_AGENT_TOKEN?.trim();
  if (!t) throw new Error("RELAY_TRAVELER_AGENT_TOKEN (or RELAY_AGENT_TOKEN) is required");
  return t;
}

async function api<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number; idempotencyKey?: string },
): Promise<T> {
  const ctrl = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 30_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { timeoutMs: _t, idempotencyKey, ...rest } = init ?? {};
    const headers: Record<string, string> = {
      authorization: `Bearer ${token()}`,
      "content-type": "application/json",
      ...(rest.headers as Record<string, string> | undefined),
    };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await fetch(`${BASE}${path}`, {
      ...rest,
      signal: ctrl.signal,
      headers,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Relay ${rest.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`Relay ${init?.method ?? "GET"} ${path} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function relayConfigured(): boolean {
  return Boolean(process.env.RELAY_TRAVELER_AGENT_TOKEN?.trim() || process.env.RELAY_AGENT_TOKEN?.trim());
}

export function webhookSecret(): string | undefined {
  return (
    process.env.RELAY_TRAVELER_WEBHOOK_SECRET?.trim() ||
    process.env.RELAY_WEBHOOK_SECRET?.trim() ||
    undefined
  );
}

export async function sendText(args: {
  conversationId: string;
  text: string;
  idempotencyKey: string;
  replyToMessageId?: string | null;
}): Promise<{ messageId?: string }> {
  const body: Record<string, unknown> = {
    conversation_id: args.conversationId,
    parts: [{ type: "text", text: args.text }],
  };
  if (args.replyToMessageId) {
    body.reply_to = { message_id: args.replyToMessageId, part_index: 0 };
  }
  const out = await api<any>("/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    idempotencyKey: args.idempotencyKey,
  });
  return { messageId: out?.message?.id ?? out?.id };
}

export async function startTyping(conversationId: string, label?: string): Promise<void> {
  try {
    await api(`/v1/conversations/${conversationId}/typing`, {
      method: "POST",
      body: JSON.stringify({ started: true, ...(label ? { label: label.slice(0, 80) } : {}) }),
      timeoutMs: 4_000,
    });
  } catch {
    /* best-effort */
  }
}

export async function stopTyping(conversationId: string): Promise<void> {
  try {
    await api(`/v1/conversations/${conversationId}/typing`, {
      method: "POST",
      body: JSON.stringify({ started: false }),
      timeoutMs: 4_000,
    });
  } catch {
    /* best-effort */
  }
}

export async function markRead(conversationId: string, messageId: string): Promise<void> {
  try {
    await api(`/v1/conversations/${conversationId}/read`, {
      method: "POST",
      body: JSON.stringify({ message_id: messageId }),
      timeoutMs: 4_000,
    });
  } catch {
    /* best-effort */
  }
}

export function verifyRelayWebhookSignature(
  secret: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const h = (k: string) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const msgId = h("webhook-id");
  const timestamp = h("webhook-timestamp");
  const signature = h("webhook-signature");
  if (!msgId || !timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const secretStr = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(secretStr, "base64");
  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", keyBytes).update(signedContent).digest("base64");
  return signature.split(" ").some((sig) => {
    if (!sig.startsWith("v1,")) return false;
    try {
      const a = Buffer.from(expected, "base64");
      const b = Buffer.from(sig.slice(3), "base64");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}

export function extractRelayInbound(event: any): {
  eventId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  text: string;
} | null {
  const eventId = String(event?.event_id ?? "");
  const msg = event?.data?.message ?? event?.message;
  if (!msg) return null;
  const conversationId = String(msg.conversation_id ?? "");
  const messageId = String(msg.id ?? "");
  const userId = String(msg.sender?.id ?? "");
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const text =
    parts
      .filter((p: any) => p?.type === "text")
      .map((p: any) => String(p.text ?? "").trim())
      .filter(Boolean)
      .join("\n") || String(msg.fallback_text ?? "").trim();
  if (!eventId || !conversationId || !userId || !text) return null;
  return { eventId, userId, conversationId, messageId, text };
}

export async function registerWebhook(url: string): Promise<{ id?: string; signingSecret?: string }> {
  const out = await api<any>("/v1/webhooks", {
    method: "POST",
    body: JSON.stringify({ url, events: ["message.received"] }),
  });
  return {
    id: out?.webhook?.id ?? out?.id,
    signingSecret: out?.signing_secret,
  };
}
