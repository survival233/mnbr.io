import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Linq Partner API v3 client (REST). Auth: Bearer LINQ_API_KEY.
 */
const BASE = process.env.LINQ_API_BASE ?? "https://api.linqapp.com/api/partner/v3";

function token(): string {
  const t = process.env.LINQ_API_KEY ?? process.env.LINQ_API_V3_API_KEY;
  if (!t) throw new Error("LINQ_API_KEY (or LINQ_API_V3_API_KEY) is required");
  return t;
}

function fromPhone(): string {
  const f = process.env.LINQ_FROM_PHONE;
  if (!f) throw new Error("LINQ_FROM_PHONE is required (your Linq Number, E.164)");
  return f;
}

async function api<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 30_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { timeoutMs: _t, ...rest } = init ?? {};
    const res = await fetch(`${BASE}${path}`, {
      ...rest,
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
        ...(rest.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Linq ${rest.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`Linq ${init?.method ?? "GET"} ${path} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendText(args: {
  toPhone: string;
  chatId?: string | null;
  text: string;
}): Promise<{ chatId: string; messageId?: string }> {
  const parts = [{ type: "text", value: args.text }];
  if (args.chatId) {
    const out = await api<any>(`/chats/${args.chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: { parts } }),
    });
    return {
      chatId: args.chatId,
      messageId: out?.id ?? out?.message?.id,
    };
  }
  const out = await api<any>("/chats", {
    method: "POST",
    body: JSON.stringify({
      from: fromPhone(),
      to: [args.toPhone],
      message: { parts },
    }),
  });
  const chatId = out?.chat?.id ?? out?.id;
  if (!chatId) throw new Error(`Linq create chat: missing id in ${JSON.stringify(out).slice(0, 300)}`);
  return { chatId, messageId: out?.chat?.message?.id ?? out?.message?.id };
}

/** iMessage “…” typing bubble. Best-effort; never block the reply path. */
export async function startTyping(chatId: string): Promise<void> {
  try {
    await api(`/chats/${chatId}/typing`, { method: "POST", timeoutMs: 4_000 });
  } catch {
    /* ignore */
  }
}

/** Mark inbound as read (blue receipts). Best-effort. */
export async function markChatRead(chatId: string): Promise<void> {
  try {
    // Partner API: POST /chats/{id}/read
    await api(`/chats/${chatId}/read`, { method: "POST", timeoutMs: 4_000 });
  } catch {
    /* ignore — wrong method/path must not stall replies */
  }
}

export function extractInboundText(data: any): string {
  const parts = data?.parts ?? [];
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p?.type === "text" || p?.value != null)
      .map((p: any) => String(p.value ?? "").trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function extractSender(data: any): string {
  return String(data?.sender_handle?.handle ?? data?.from ?? "");
}

export function extractChatId(data: any): string | null {
  return data?.chat?.id ?? data?.chat_id ?? null;
}

/** Standard Webhooks verification (optional when LINQ_WEBHOOK_SECRET is set). */
export function verifyWebhookSignature(
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
