/**
 * Sandbox AgentCard client — wallets / cards only.
 * Does not search merchants or replace Manebra catalog.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const API_BASE = () => (process.env.AGENTCARD_API_BASE?.trim() || "https://api.agentcard.sh").replace(/\/$/, "");

export type AgentCardConnection = {
  identity: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
};

type Store = { connections: AgentCardConnection[] };

let orgToken: { value: string; exp: number; clientId: string } | null = null;

export function agentcardConfigured(): boolean {
  return Boolean(process.env.AGENTCARD_CLIENT_ID?.trim() && process.env.AGENTCARD_CLIENT_SECRET?.trim());
}

function storePath(): string {
  return process.env.AGENTCARD_STORE_PATH?.trim() || ".agentcard-store.json";
}

function loadStore(): Store {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Store;
    return { connections: Array.isArray(raw.connections) ? raw.connections : [] };
  } catch {
    return { connections: [] };
  }
}

function saveStore(store: Store): void {
  const p = storePath();
  mkdirSync(dirname(p) === "." ? "." : dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2));
}

export function getConnection(identity: string): AgentCardConnection | null {
  return loadStore().connections.find((c) => c.identity === identity) ?? null;
}

function putConnection(row: AgentCardConnection): void {
  const store = loadStore();
  const i = store.connections.findIndex((c) => c.identity === row.identity);
  if (i >= 0) store.connections[i] = row;
  else store.connections.push(row);
  saveStore(store);
}

async function orgAccessToken(): Promise<string> {
  const clientId = process.env.AGENTCARD_CLIENT_ID?.trim();
  const clientSecret = process.env.AGENTCARD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("AGENTCARD_CLIENT_ID / AGENTCARD_CLIENT_SECRET unset");
  if (orgToken && orgToken.clientId === clientId && orgToken.exp > Date.now() + 30_000) return orgToken.value;
  const res = await fetch(`${API_BASE()}/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`AgentCard oauth failed (${res.status})`);
  }
  orgToken = { value: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000, clientId };
  return orgToken.value;
}

/** Mint (or reuse) the platform token. Never log the secret or the token. */
export async function mintPlatformToken(): Promise<boolean> {
  if (!agentcardConfigured()) return false;
  await orgAccessToken();
  return true;
}

function looksLikePhone(identity: string): boolean {
  return /^\+?[1-9]\d{7,14}$/.test(identity.replace(/[\s()-]/g, ""));
}

function sandboxEmail(identity: string): string {
  const safe = identity.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "user";
  return `${safe}@sandbox.manebra.local`;
}

async function api<T>(path: string, init: RequestInit & { token?: string; timeoutMs?: number }): Promise<T> {
  const token = init.token ?? (await orgAccessToken());
  const { token: _t, timeoutMs, ...rest } = init;
  const ctrl = timeoutMs ? new AbortController() : undefined;
  const timer = timeoutMs ? setTimeout(() => ctrl!.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(`${API_BASE()}${path}`, {
      ...rest,
      signal: ctrl?.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(rest.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
    if (!res.ok) {
      throw new Error(`AgentCard ${path} failed (${res.status})`);
    }
    return body;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type BuyTurn = {
  conversation_id?: string;
  status?: string;
  reply?: string;
};

/** Traveler store checkout AFTER shopper funded. Connection token, never the org token. */
export async function buyWithUserCard(identity: string, ask: string): Promise<BuyTurn> {
  const conn = await connectIdentity(identity);
  return api<BuyTurn>("/buy", {
    method: "POST",
    token: conn.accessToken,
    timeoutMs: 120_000,
    body: JSON.stringify({ ask }),
  });
}

/** Connect (sandbox verify 111111) + consent. Idempotent per identity. */
export async function connectIdentity(identity: string): Promise<AgentCardConnection> {
  const existing = getConnection(identity);
  if (existing?.userId) return existing;

  const startBody = looksLikePhone(identity)
    ? { phone: identity.startsWith("+") ? identity : `+${identity}`, external_user_id: identity }
    : { email: sandboxEmail(identity), external_user_id: identity };

  const attempt = await api<{ id: string }>("/api/v2/connect/start", {
    method: "POST",
    body: JSON.stringify(startBody),
  });
  const connection = await api<{
    access_token: string;
    refresh_token: string;
    user: { id: string };
  }>("/api/v2/connect/verify", {
    method: "POST",
    body: JSON.stringify({ connect_id: attempt.id, code: "111111" }),
  });
  await api("/api/v2/connect/consent", {
    method: "POST",
    body: JSON.stringify({ user_id: connection.user.id }),
  });
  const row: AgentCardConnection = {
    identity,
    userId: connection.user.id,
    accessToken: connection.access_token,
    refreshToken: connection.refresh_token,
  };
  putConnection(row);
  return row;
}

export type WalletLink = { id: string; url: string; user_id: string };

export async function createWalletLink(identity: string): Promise<WalletLink> {
  const conn = await connectIdentity(identity);
  const link = await api<WalletLink>("/api/v2/wallet_links", {
    method: "POST",
    body: JSON.stringify({ user_id: conn.userId }),
  });
  if (!link.url) throw new Error("AgentCard wallet_links missing url");
  return link;
}

/** Hosted pay-sheet: same wallet_link + merchant + amount (cents). */
export function paySheetUrl(walletUrl: string, merchant: string, amountCents: number): string {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("pay-sheet amountCents must be a positive integer (recap total)");
  }
  const u = new URL(walletUrl);
  u.searchParams.set("merchant", merchant);
  u.searchParams.set("amount", String(amountCents));
  return u.toString();
}
