/**
 * AgentCard webhook handler. Trust connected_card.updated (not chat "done").
 * Mounted on the existing shopper/traveler HTTP servers — no new endpoint.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { setConnectedCard } from "@manebra/db";
import { identityForAgentCardUser, rememberAgentCardUser } from "@repo/agentcard";

const seen = new Set<string>();

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function isAgentCardRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return Boolean(
    header(headers, "agentcard-signature") || header(headers, "x-agentcard-signature"),
  );
}

export function verifyAgentCardSignature(secret: string, raw: string, sigHeader: string | undefined): boolean {
  if (!sigHeader) return false;
  if (sigHeader.startsWith("sha256=")) {
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const got = sigHeader.slice("sha256=".length);
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
    } catch {
      return false;
    }
  }
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch {
    return false;
  }
}

function remember(id: string | undefined): boolean {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 4000) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  return true;
}

type Envelope = {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
};

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function bagIdentity(bag: Record<string, unknown> | undefined): string | undefined {
  if (!bag) return undefined;
  return asString(bag.external_user_id) ?? asString(bag.externalUserId);
}

function bagUserId(bag: Record<string, unknown> | undefined): string | undefined {
  if (!bag) return undefined;
  const user = asRecord(bag.user);
  return asString(bag.user_id) ?? asString(bag.userId) ?? asString(user?.id);
}

/** Persist last4/brand from connected_card.updated. PCI number never lands here. */
export async function applyConnectedCardUpdated(data: Record<string, unknown> | undefined): Promise<void> {
  if (!data) return;
  const card = asRecord(data.card) ?? asRecord(data.object) ?? data;
  const user = asRecord(data.user) ?? asRecord(card.user);
  const rawUserId = bagUserId(data) ?? bagUserId(card) ?? bagUserId(user);
  const rawExternal = bagIdentity(data) ?? bagIdentity(card) ?? bagIdentity(user);
  const mapped = rawUserId ? identityForAgentCardUser(rawUserId) : null;
  const identity = rawExternal ?? mapped ?? rawUserId;
  if (!identity) {
    console.warn("[webhooks/agentcard] connected_card.updated missing identity");
    return;
  }
  if (rawExternal && rawUserId) rememberAgentCardUser(rawExternal, rawUserId);
  await setConnectedCard({
    identity,
    agentcardUserId: rawUserId ?? mapped ?? undefined,
    last4: asString(card.last4) ?? asString(data.last4),
    brand: asString(card.brand) ?? asString(data.brand) ?? asString(card.network),
    isDefault: true,
  });
  console.log(`[webhooks/agentcard] connected_card.updated identity=${identity} last4=${asString(card.last4) ?? "****"}`);
}

function eventIdentity(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const card = asRecord(data.card) ?? asRecord(data.object);
  const user = asRecord(data.user);
  const rawUserId = bagUserId(data) ?? bagUserId(card) ?? bagUserId(user);
  const rawExternal = bagIdentity(data) ?? bagIdentity(card) ?? bagIdentity(user);
  return rawExternal ?? (rawUserId ? identityForAgentCardUser(rawUserId) ?? rawUserId : undefined);
}

export type AgentCardWebhookResult = {
  ok: boolean;
  status: number;
  type?: string;
  identity?: string;
  payment?: boolean;
};

export async function handleAgentCardWebhook(
  raw: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<AgentCardWebhookResult> {
  const secret = process.env.AGENTCARD_WEBHOOK_SECRET?.trim();
  const sig = header(headers, "agentcard-signature") ?? header(headers, "x-agentcard-signature");
  if (secret) {
    if (!verifyAgentCardSignature(secret, raw, sig)) {
      return { ok: false, status: 401 };
    }
  } else if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 500 };
  }

  let event: Envelope;
  try {
    event = JSON.parse(raw) as Envelope;
  } catch {
    return { ok: false, status: 400 };
  }

  if (!remember(event.id)) return { ok: true, status: 200, type: event.type };

  if (event.type === "connected_card.updated") {
    await applyConnectedCardUpdated(event.data);
  }
  if (event.type === "connection.created" && event.data) {
    const ext = bagIdentity(event.data);
    const uid = bagUserId(event.data);
    if (ext && uid) rememberAgentCardUser(ext, uid);
  }

  const identity = eventIdentity(event.data);
  const payment = Boolean(event.type && /^(transaction\.|payment\.)/i.test(event.type));
  return { ok: true, status: 200, type: event.type, identity, payment };
}
