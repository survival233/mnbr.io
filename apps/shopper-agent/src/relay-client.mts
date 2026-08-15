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

function pushImageRef(urls: string[], url?: string | null, attachmentId?: string | null) {
  const u = typeof url === "string" ? url.trim() : "";
  if (u.startsWith("http")) {
    urls.push(u);
    return;
  }
  const id = typeof attachmentId === "string" ? attachmentId.trim() : "";
  if (id) urls.push(`relay-att:${id}`);
}

/** Relay phone uploads arrive as `data` artifacts, not `media` parts. */
function imageRefFromDataPart(p: any): { url?: string; attachmentId?: string } | null {
  if (!p || p.type !== "data") return null;
  const payload = p.data ?? p;
  const artifact = payload?.artifact ?? (payload?.type === "artifact" ? payload : null);
  if (!artifact || typeof artifact !== "object") return null;
  const kind = String(artifact.kind ?? artifact.media_kind ?? "").toLowerCase();
  const mime = String(artifact.mimeType ?? artifact.content_type ?? artifact.mime_type ?? "").toLowerCase();
  const isImage =
    kind === "image" ||
    mime.startsWith("image/") ||
    /\.(jpe?g|png|gif|webp|heic)$/i.test(String(artifact.title ?? artifact.name ?? ""));
  if (!isImage) return null;
  return {
    url: typeof artifact.url === "string" ? artifact.url : undefined,
    attachmentId:
      typeof artifact.id === "string"
        ? artifact.id
        : typeof payload?.id === "string"
          ? payload.id
          : undefined,
  };
}

function isMediaImagePart(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  if (p.type !== "media" && p.type !== "image") return false;
  const kind = String(p.media_kind ?? "").toLowerCase();
  const ct = String(p.content_type ?? "").toLowerCase();
  if (kind === "video" || kind === "audio" || kind === "file") return false;
  if (ct.startsWith("video/") || ct.startsWith("audio/")) return false;
  if (kind === "image" || ct.startsWith("image/")) return true;
  return Boolean(p.url || p.attachment_id);
}

/** Collect HTTPS / capability URLs from inbound media + image artifact parts. */
export function extractRelayImageUrls(event: any): string[] {
  const msg = event?.data?.message ?? event?.message;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  const urls: string[] = [];
  for (const p of parts) {
    const fromData = imageRefFromDataPart(p);
    if (fromData) {
      pushImageRef(urls, fromData.url, fromData.attachmentId);
      continue;
    }
    if (isMediaImagePart(p)) {
      pushImageRef(urls, p.url, p.attachment_id);
      continue;
    }
    const file = p?.file ?? p?.image ?? p?.media;
    if (file && typeof file === "object") {
      const mime = String(file.mime_type ?? file.content_type ?? file.mimeType ?? "").toLowerCase();
      if (!mime || mime.startsWith("image/")) {
        pushImageRef(urls, file.url, file.id ?? file.attachment_id);
      }
    }
  }
  const atts = msg?.attachments ?? event?.data?.attachments ?? [];
  if (Array.isArray(atts)) {
    for (const a of atts) {
      const mime = String(a?.mime_type ?? a?.content_type ?? a?.mimeType ?? "").toLowerCase();
      if (mime && !mime.startsWith("image/")) continue;
      pushImageRef(urls, a?.url, a?.id ?? a?.attachment_id);
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
      const kind = ref.startsWith("relay-att:") ? "att" : ref.startsWith("data:") ? "data" : ref.startsWith("http") ? "http" : "other";
      console.log(`[relay] vision ref kind=${kind} hasUrl=${kind === "http" || kind === "data"}`);
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

function urlHost(url: string): string {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "invalid";
  }
}

async function downloadAsDataUrl(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const host = urlHost(url);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token()}` },
    });
    let used = res;
    let auth = "bearer";
    if (!res.ok) {
      const res2 = await fetch(url, { signal: ctrl.signal });
      if (!res2.ok) {
        console.warn(`[relay] vision fetch host=${host} status=${res.status}/${res2.status} ok=false`);
        throw new Error(`download ${res.status}/${res2.status}`);
      }
      used = res2;
      auth = "none";
    }
    const buf = await used.arrayBuffer();
    const dataUrl = bufferToDataUrl(buf, used.headers.get("content-type"));
    console.log(
      `[relay] vision fetch host=${host} auth=${auth} status=${used.status} bytes=${buf.byteLength} out=${dataUrl ? "data" : "none"}`,
    );
    return dataUrl;
  } finally {
    clearTimeout(timer);
  }
}

function bufferToDataUrl(buf: ArrayBuffer, contentType: string | null): string | null {
  if (buf.byteLength === 0 || buf.byteLength > 6_000_000) return null;
  let ct = (contentType ?? "image/jpeg").split(";")[0]!.trim() || "image/jpeg";
  // Relay capability URLs sometimes return octet-stream for JPEGs.
  if (!ct.startsWith("image/")) {
    if (ct === "application/octet-stream" || ct === "binary/octet-stream" || !ct) ct = "image/jpeg";
    else return null;
  }
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
  const textParts = parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => String(p.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const imageRefs = extractRelayImageUrls(event);
  // Phone photo uploads often only have fallback_text "Photo" + a data artifact.
  let text = textParts;
  if (!text && imageRefs.length === 0) {
    text = String(msg.fallback_text ?? "").trim();
  } else if (!text && imageRefs.length > 0) {
    text = ""; // ignore Photo/[attachment] fallback when we have the image
  }
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
