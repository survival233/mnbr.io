/**
 * AgentCard webhook handler. Trust connected_card.updated (not chat "done").
 * Mounted on the existing shopper/traveler HTTP servers — no new endpoint.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { setConnectedCard } from "@manebra/db";

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
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Persist last4/brand from connected_card.updated. PCI number never lands here. */
export async function applyConnectedCardUpdated(data: Record<string, unknown> | undefined): Promise<void> {
  if (!data) return;
  const card = (data.card && typeof data.card === "object" ? data.card : data) as Record<string, unknown>;
  const identity =
    asString(data.external_user_id) ?? asString(data.externalUserId) ?? asString(data.user_id) ?? asString(data.userId);
  if (!identity) {
    console.warn("[webhooks/agentcard] connected_card.updated missing identity");
    return;
  }
  await setConnectedCard({
    identity,
    agentcardUserId: asString(data.user_id) ?? asString(data.userId),
    last4: asString(card.last4) ?? asString(data.last4),
    brand: asString(card.brand) ?? asString(data.brand) ?? asString(card.network),
    isDefault: true,
  });
  console.log(`[webhooks/agentcard] connected_card.updated identity=${identity} last4=${asString(card.last4) ?? "****"}`);
}

function eventIdentity(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  return (
    asString(data.external_user_id) ??
    asString(data.externalUserId) ??
    asString(data.user_id) ??
    asString(data.userId)
  );
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

  const identity = eventIdentity(event.data);
  const payment = Boolean(event.type && /^(transaction\.|payment\.)/i.test(event.type));
  return { ok: true, status: 200, type: event.type, identity, payment };
}
