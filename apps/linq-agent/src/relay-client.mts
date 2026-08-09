import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Relay developer API (https://api.relayapp.im).
 * Auth: Bearer RELAY_AGENT_TOKEN. No SDK — plain HTTPS + JSON.
 */
const BASE = process.env.RELAY_API_URL ?? "https://api.relayapp.im";

function token(): string {
  const t = process.env.RELAY_AGENT_TOKEN;
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
    await api(`/v1/conversations/${conversationId}/read`, {
      method: "POST",
      body: JSON.stringify({ message_id: messageId }),
      timeoutMs: 4_000,
    });
  } catch {
    /* best-effort — path may vary */
  }
}

/** Standard Webhooks verification (same shape as Linq). */
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

function isImagePart(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  if (p.type !== "media" && p.type !== "image") return false;
  const kind = String(p.media_kind ?? "").toLowerCase();
  const ct = String(p.content_type ?? "").toLowerCase();
  if (kind === "video" || kind === "audio" || kind === "file") return false;
  if (ct.startsWith("video/") || ct.startsWith("audio/")) return false;
  if (kind === "image" || ct.startsWith("image/")) return true;
  // Default media without kind: treat as image if url/attachment looks usable
  return Boolean(p.url || p.attachment_id);
}

/** Collect HTTPS / capability URLs from inbound media parts (images only). */
export function extractRelayImageUrls(event: any): string[] {
  const msg = event?.data?.message ?? event?.message;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  const urls: string[] = [];
  for (const p of parts) {
    if (!isImagePart(p)) continue;
    const u = typeof p.url === "string" ? p.url.trim() : "";
    if (u.startsWith("http")) urls.push(u);
    else if (typeof p.attachment_id === "string" && p.attachment_id) {
      // Resolve later via fetchAttachmentUrl
      urls.push(`relay-att:${p.attachment_id}`);
    }
  }
  return [...new Set(urls)].slice(0, 3);
}

export async function fetchAttachmentUrl(attachmentId: string): Promise<string | null> {
  try {
    const out = await api<any>(`/v1/attachments/${attachmentId}`, { method: "GET", timeoutMs: 8_000 });
    const u = out?.attachment?.url ?? out?.url;
    return typeof u === "string" && u.startsWith("http") ? u : null;
  } catch (e: any) {
    console.warn(`[relay] attachment meta failed: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Turn Relay capability / attachment refs into OpenAI-safe image URLs.
 * Downloads with the agent token and returns data: URLs when needed
 * (OpenAI cannot use Bearer-auth Relay URLs).
 */
export async function resolveImagesForVision(refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs.slice(0, 3)) {
    try {
      let url = ref;
      if (ref.startsWith("relay-att:")) {
        const id = ref.slice("relay-att:".length);
        const resolved = await fetchAttachmentUrl(id);
        if (!resolved) continue;
        url = resolved;
      }
      const dataUrl = await downloadAsDataUrl(url);
      if (dataUrl) out.push(dataUrl);
    } catch (e: any) {
      console.warn(`[relay] vision image resolve failed: ${e?.message ?? e}`);
    }
  }
  return out;
}

async function downloadAsDataUrl(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token()}` },
    });
    if (!res.ok) {
      // Some capability URLs are public; retry without auth
      const res2 = await fetch(url, { signal: ctrl.signal });
      if (!res2.ok) throw new Error(`download ${res.status}/${res2.status}`);
      return bufferToDataUrl(await res2.arrayBuffer(), res2.headers.get("content-type"));
    }
    return bufferToDataUrl(await res.arrayBuffer(), res.headers.get("content-type"));
  } finally {
    clearTimeout(timer);
  }
}

function bufferToDataUrl(buf: ArrayBuffer, contentType: string | null): string | null {
  if (buf.byteLength === 0 || buf.byteLength > 6_000_000) return null;
  const ct = (contentType ?? "image/jpeg").split(";")[0]!.trim() || "image/jpeg";
  if (!ct.startsWith("image/")) return null;
  return `data:${ct};base64,${Buffer.from(buf).toString("base64")}`;
}

export function extractRelayInbound(event: any): {
  eventId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  text: string;
  imageRefs: string[];
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
      .filter((p: any) => p?.type === "text" || (p?.text != null && p?.type !== "media"))
      .map((p: any) => String(p.text ?? "").trim())
      .filter(Boolean)
      .join("\n") || String(msg.fallback_text ?? "").trim();
  const imageRefs = extractRelayImageUrls(event);
  if (!eventId || !conversationId || !userId) return null;
  if (!text && imageRefs.length === 0) return null;
  return { eventId, userId, conversationId, messageId, text, imageRefs };
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

export async function verifyAgentToken(): Promise<{ id?: string; name?: string }> {
  const out = await api<any>("/v1/agents/me", { method: "GET" });
  return { id: out?.agent?.id ?? out?.id, name: out?.agent?.name ?? out?.name };
}
