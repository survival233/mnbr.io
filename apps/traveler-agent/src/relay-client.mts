import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Optional Relay chat pipe (same env names as shopper).
 * Auth: Bearer RELAY_AGENT_TOKEN — leave unset until you have a Relay agent.
 */
const BASE = process.env.RELAY_API_URL ?? "https://api.relayapp.im";

function token(): string {
  const t = process.env.RELAY_AGENT_TOKEN?.trim();
  if (!t) throw new Error("RELAY_AGENT_TOKEN is required");
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
  return Boolean(process.env.RELAY_AGENT_TOKEN?.trim());
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
    await api(`/v1/conversations/${conversationId}/responding`, {
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
  const msgId = h("webhook-id") ?? h("svix-id");
  const timestamp = h("webhook-timestamp") ?? h("svix-timestamp");
  const signature = h("webhook-signature") ?? h("svix-signature");
  if (!msgId || !timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const trimmed = secret.trim().replace(/^["']|["']$/g, "");
  const secretStr = trimmed.startsWith("whsec_") ? trimmed.slice(6) : trimmed;
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

let runtimeSigningSecret: string | undefined;

function rememberSigningSecret(secret?: string) {
  const s = secret?.trim();
  if (!s) return;
  runtimeSigningSecret = s;
  process.env.RELAY_WEBHOOK_SECRET = s;
}

/** Env secret plus the one Relay returned at boot (create / rotate). */
export function relayWebhookSecrets(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [runtimeSigningSecret, process.env.RELAY_WEBHOOK_SECRET?.trim()]) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function rotateSigningSecret(id: string): Promise<void> {
  const out = await api<any>(`/v1/webhooks/${id}/rotate-secret`, { method: "POST", timeoutMs: 8_000 });
  rememberSigningSecret(out?.signing_secret);
  console.log(`[relay] rotated signing secret for ${id}`);
}

/** On Render, register our HTTPS receiver with the agent token. Phone chat has no webhook UI. */
export async function ensureCloudWebhook(): Promise<void> {
  if (process.env.DEMO_RELAY_POLL === "1") return;
  if (!relayConfigured()) return;
  const base = (process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
  if (!base.startsWith("https://")) return;
  const want = `${base}/webhooks/relay`;
  try {
    const me = await api<any>("/v1/agents/me", { method: "GET", timeoutMs: 8_000 });
    const agent = me?.agent ?? me;
    console.log(`[relay] agent handle=${agent?.handle ?? "?"} id=${agent?.id ?? "?"}`);
    const out = await api<{ webhooks?: { id: string; url: string; events?: string[]; enabled: boolean }[] }>(
      "/v1/webhooks",
      { method: "GET", timeoutMs: 8_000 },
    );
    const hooks = out?.webhooks ?? [];
    console.log(`[relay] webhooks ${hooks.length} want=${want}`);
    for (const w of hooks) {
      console.log(`[relay] ${w.id} enabled=${w.enabled} url=${w.url} events=${(w.events ?? []).join(",")}`);
    }
    let mine = hooks.find((w) => w.url.replace(/\/$/, "") === want) ?? hooks[0];
    if (!mine) {
      const created = await registerWebhook(want);
      rememberSigningSecret(created.signingSecret);
      console.log(`[relay] created webhook ${created.id ?? "?"} for ${want}`);
      return;
    }
    const events = mine.events ?? [];
    const needEvents = !events.includes("message.received");
    const needEnable = mine.enabled === false;
    const needUrl = mine.url.replace(/\/$/, "") !== want;
    if (needEvents || needEnable || needUrl) {
      await api(`/v1/webhooks/${mine.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(needUrl ? { url: want } : {}),
          ...(needEnable ? { enabled: true } : {}),
          ...(needEvents ? { events: ["message.received"] } : {}),
        }),
        timeoutMs: 8_000,
      });
      console.log(`[relay] patched ${mine.id} url=${needUrl} enabled=${needEnable} events=${needEvents}`);
    }
    // List never returns the secret; rotate so this process can verify inbound.
    await rotateSigningSecret(mine.id);
  } catch (e: any) {
    console.warn(`[relay] webhook check: ${e?.message ?? e}`);
  }
}

/** Telegram-style long poll. 409 if a webhook is still enabled on this token. */
export async function pollEvents(args: {
  cursor?: number;
  timeout: number;
  limit?: number;
}): Promise<{ events: any[]; next_cursor: number }> {
  const q = new URLSearchParams({
    timeout: String(args.timeout),
    cursor: String(args.cursor ?? 0),
    limit: String(args.limit ?? 100),
  });
  return api(`/v1/events?${q}`, {
    method: "GET",
    timeoutMs: Math.max(35_000, args.timeout * 1000 + 10_000),
  });
}
