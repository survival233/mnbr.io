import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Optional Relay chat pipe (same env names as shopper).
 * Auth: Bearer RELAY_AGENT_TOKEN — leave unset until you have a Relay agent.
 */
const BASE = process.env.RELAY_API_URL ?? "https://api.relayapp.im";

function cleanToken(value?: string): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "");
}

const TOKEN_KEYS = ["RELAY_TRAVELER_AGENT_TOKEN", "RELAY_AGENT_TOKEN"] as const;

let resolvedToken: string | undefined;

function tokenCandidates(): { key: string; value: string }[] {
  const seen = new Set<string>();
  const out: { key: string; value: string }[] = [];
  for (const key of TOKEN_KEYS) {
    const value = cleanToken(process.env[key]);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ key, value });
  }
  return out;
}

function token(): string {
  if (resolvedToken) return resolvedToken;
  const first = tokenCandidates()[0];
  if (!first) throw new Error("RELAY_AGENT_TOKEN is required");
  return first.value;
}

function relayErrorMeta(text: string): { errorCode?: number; errorMessage?: string } {
  try {
    const body = JSON.parse(text);
    return { errorCode: body?.error?.code, errorMessage: body?.error?.message };
  } catch {
    return {};
  }
}

async function probeRelayPath(
  path: string,
  tokenValue: string,
): Promise<{ status: number; ok: boolean; errorCode?: number; errorMessage?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${tokenValue}`, "user-agent": "relay-docs/1.0" },
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, ...relayErrorMeta(text) };
  } catch (e: any) {
    return { status: 0, ok: false, errorMessage: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

function agentLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
  runId = "pre-fix",
) {
  // #region agent log
  fetch("http://127.0.0.1:7854/ingest/a231508e-92f8-412b-a181-535e3ce153db", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "38c5c9" },
    body: JSON.stringify({
      sessionId: "38c5c9",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

/** Probe /v1/agents/me vs /v1/chats without accepting a token. */
export async function debugProbeRelayAuth(): Promise<void> {
  const candidates = tokenCandidates();
  agentLog("A", "relay-client.mts:debugProbeRelayAuth", "token candidates", {
    keys: candidates.map((c) => c.key),
    lens: candidates.map((c) => c.value.length),
    prefixes: candidates.map((c) => c.value.slice(0, 8)),
    base: BASE,
  });
  for (const c of candidates) {
    const me = await probeRelayPath("/v1/agents/me", c.value);
    const chats = await probeRelayPath("/v1/chats?limit=1", c.value);
    const subs = await probeRelayPath("/v1/webhook-subscriptions", c.value);
    agentLog("A", "relay-client.mts:debugProbeRelayAuth", "endpoint compare", {
      key: c.key,
      me,
      chats,
      subs,
    });
    console.log(
      `[relay] probe key=${c.key} agents/me=${me.status}/${me.errorCode ?? "-"} chats=${chats.status}/${chats.errorCode ?? "-"} subs=${subs.status}/${subs.errorCode ?? "-"}`,
    );
  }
}

/** Prefer RELAY_TRAVELER_AGENT_TOKEN; fall back if RELAY_AGENT_TOKEN is stale. */
export async function resolveAgentToken(): Promise<void> {
  const candidates = tokenCandidates();
  if (candidates.length === 0) return;
  for (const c of candidates) {
    const me = await probeRelayPath("/v1/agents/me", c.value);
    agentLog("B", "relay-client.mts:resolveAgentToken", "agents/me result", {
      key: c.key,
      status: me.status,
      ok: me.ok,
      errorCode: me.errorCode,
      errorMessage: me.errorMessage,
    });
    const chats = await probeRelayPath("/v1/chats?limit=1", c.value);
    agentLog(
      "A",
      "relay-client.mts:resolveAgentToken",
      "chats verify",
      {
        key: c.key,
        status: chats.status,
        ok: chats.ok,
        errorCode: chats.errorCode,
        errorMessage: chats.errorMessage,
        meStatus: me.status,
      },
      "post-fix",
    );
    if (!chats.ok) {
      console.warn(`[relay] token key=${c.key} chats=${chats.status} me=${me.status}`);
      continue;
    }
    resolvedToken = c.value;
    console.log(`[relay] token key=${c.key} chats=ok me=${me.status}`);
    return;
  }
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
  return tokenCandidates().length > 0;
}

export function relayTokenKeyNames(): string[] {
  return tokenCandidates().map((c) => c.key);
}

export async function sendText(args: {
  conversationId: string;
  text: string;
  idempotencyKey: string;
  replyToMessageId?: string | null;
}): Promise<{ messageId?: string }> {
  const message: Record<string, unknown> = {
    parts: [{ type: "text", value: args.text }],
    idempotency_key: args.idempotencyKey,
  };
  if (args.replyToMessageId) {
    message.reply_to = { message_id: args.replyToMessageId, part_index: 0 };
  }
  const out = await api<any>(`/v1/chats/${args.conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
    idempotencyKey: args.idempotencyKey,
  });
  return { messageId: out?.message?.id ?? out?.id };
}

export async function startTyping(conversationId: string, _label?: string): Promise<void> {
  try {
    await api(`/v1/chats/${conversationId}/typing`, {
      method: "POST",
      timeoutMs: 4_000,
    });
  } catch {
    /* best-effort */
  }
}

export async function stopTyping(conversationId: string): Promise<void> {
  try {
    await api(`/v1/chats/${conversationId}/typing`, {
      method: "DELETE",
      timeoutMs: 4_000,
    });
  } catch {
    /* best-effort */
  }
}

export async function markRead(conversationId: string, _messageId?: string): Promise<void> {
  try {
    await api(`/v1/chats/${conversationId}/read`, {
      method: "POST",
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
  const data = event?.data ?? event;
  const msg = data?.message ?? data;
  const conversationId = String(data?.chat?.id ?? msg?.conversation_id ?? msg?.chat_id ?? "");
  const messageId = String(data?.id ?? msg?.id ?? "");
  const userId = String(
    data?.sender_handle?.id ?? msg?.sender_handle?.id ?? msg?.sender?.id ?? "",
  );
  const parts = Array.isArray(data?.parts) ? data.parts : Array.isArray(msg?.parts) ? msg.parts : [];
  const text =
    parts
      .filter((p: any) => p?.type === "text")
      .map((p: any) => String(p.value ?? p.text ?? "").trim())
      .filter(Boolean)
      .join("\n") || String(msg?.fallback_text ?? data?.fallback_text ?? "").trim();
  if (!eventId || !conversationId || !userId || !text) return null;
  return { eventId, userId, conversationId, messageId, text };
}

export async function registerWebhook(
  url: string,
  events: string[],
): Promise<{ id?: string; signingSecret?: string }> {
  const out = await api<any>("/v1/webhook-subscriptions", {
    method: "POST",
    body: JSON.stringify({ target_url: url, subscribed_events: events }),
  });
  return {
    id: out?.id,
    signingSecret: out?.signing_secret ?? out?.signingSecret,
  };
}

let runtimeSigningSecret: string | undefined;

function rememberSigningSecret(secret?: string) {
  const s = secret?.trim();
  if (!s) return;
  runtimeSigningSecret = s;
  process.env.RELAY_WEBHOOK_SECRET = s;
  try {
    const p = fileURLToPath(new URL("./../.env", import.meta.url));
    let text = readFileSync(p, "utf8");
    if (/^RELAY_WEBHOOK_SECRET=/m.test(text)) {
      text = text.replace(/^RELAY_WEBHOOK_SECRET=.*$/m, `RELAY_WEBHOOK_SECRET=${s}`);
    } else {
      text = `${text.trimEnd()}\nRELAY_WEBHOOK_SECRET=${s}\n`;
    }
    writeFileSync(p, text);
  } catch {
    /* local persist best-effort */
  }
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
  rememberSigningSecret(out?.signing_secret ?? out?.signingSecret);
  console.log(`[relay] rotated signing secret for ${id}`);
}

/** On Render, register our HTTPS receiver with the agent token. Phone chat has no webhook UI. */
export async function ensureCloudWebhook(): Promise<void> {
  const renderBase = (process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
  const skip = {
    demoPoll: process.env.DEMO_RELAY_POLL === "1",
    configured: relayConfigured(),
    renderHttps: renderBase.startsWith("https://"),
  };
  agentLog("C", "relay-client.mts:ensureCloudWebhook", "entry", {
    ...skip,
    renderHost: renderBase ? new URL(renderBase).host : "",
  });
  if (skip.demoPoll) return;
  if (!skip.configured) return;
  if (!skip.renderHttps) return;
  await resolveAgentToken();
  agentLog("C", "relay-client.mts:ensureCloudWebhook", "after resolve", {
    accepted: Boolean(resolvedToken),
  });
  if (!resolvedToken) {
    console.warn("[relay] no valid agent token — phone messages will not deliver");
    return;
  }
  const base = renderBase;
  const want = `${base}/webhooks/relay`;
  try {
    const catalog = await api<{ events?: string[] }>("/v1/webhook-events", { method: "GET", timeoutMs: 8_000 });
    const subscribed =
      catalog.events?.filter((e) => typeof e === "string") ?? ["message.received", "contact.added"];
    const listed = await api<{ subscriptions?: { id: string; target_url: string; subscribed_events?: string[]; is_active: boolean }[] }>(
      "/v1/webhook-subscriptions",
      { method: "GET", timeoutMs: 8_000 },
    );
    const hooks = listed.subscriptions ?? [];
    agentLog(
      "C",
      "relay-client.mts:ensureCloudWebhook",
      "subscriptions",
      {
        want,
        count: hooks.length,
        urls: hooks.map((w) => w.target_url),
        active: hooks.map((w) => w.is_active),
        catalog: subscribed.length,
      },
      "post-fix",
    );
    console.log(`[relay] subscriptions ${hooks.length} want=${want}`);
    const wantHost = new URL(want).host;
    const mine = hooks.filter((w) => {
      try {
        return w.target_url.replace(/\/$/, "") === want || new URL(w.target_url).host === wantHost;
      } catch {
        return false;
      }
    });
    for (const w of mine) {
      try {
        await api(`/v1/webhook-subscriptions/${w.id}`, { method: "DELETE", timeoutMs: 8_000 });
        console.log(`[relay] deleted subscription ${w.id}`);
      } catch (e: any) {
        console.warn(`[relay] delete ${w.id}: ${e?.message ?? e}`);
      }
    }
    const created = await registerWebhook(want, subscribed);
    rememberSigningSecret(created.signingSecret);
    console.log(`[relay] created subscription ${created.id ?? "?"} for ${want} secret=${created.signingSecret ? "yes" : "no"}`);
  } catch (e: any) {
    agentLog(
      "C",
      "relay-client.mts:ensureCloudWebhook",
      "subscription error",
      { error: String(e?.message ?? e).slice(0, 240) },
      "post-fix",
    );
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
