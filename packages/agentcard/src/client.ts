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

type CredPair = { source: "client" | "oauth"; id: string; secret: string };

export function agentcardConfigured(): boolean {
  return credPairs().length > 0;
}

function credPairs(): CredPair[] {
  const out: CredPair[] = [];
  const cid = process.env.AGENTCARD_CLIENT_ID?.trim();
  const csec = process.env.AGENTCARD_CLIENT_SECRET?.trim();
  if (cid && csec) out.push({ source: "client", id: cid, secret: csec });
  const oid = process.env.AGENTCARD_OAUTH_CLIENT_ID?.trim();
  const osec = process.env.AGENTCARD_OAUTH_CLIENT_SECRET?.trim();
  if (oid && osec && !out.some((p) => p.id === oid)) {
    out.push({ source: "oauth", id: oid, secret: osec });
  }
  return out;
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

export function dropConnection(identity: string): void {
  const store = loadStore();
  const next = store.connections.filter((c) => c.identity !== identity);
  if (next.length === store.connections.length) return;
  saveStore({ connections: next });
}

export class AgentCardLoginError extends Error {
  constructor(message = "AgentCard login failed") {
    super(message);
    this.name = "AgentCardLoginError";
  }
}

export function isAgentCardLoginError(e: unknown): boolean {
  if (e instanceof AgentCardLoginError) return true;
  return /\b(401|403|login failed|unauthorized|invalid[_ ]token)\b/i.test(String((e as any)?.message ?? e));
}

async function mintOrgToken(
  pair: CredPair,
): Promise<{ token: string; exp: number } | { status: number }> {
  const res = await fetch(`${API_BASE()}/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: pair.id,
      client_secret: pair.secret,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  // #region agent log
  fetch("http://127.0.0.1:7792/ingest/af7dba43-916f-44eb-8996-041bf3055f0c", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ee46bb" },
    body: JSON.stringify({
      sessionId: "ee46bb",
      runId: "post-fix",
      hypothesisId: "P",
      location: "packages/agentcard/src/client.ts:mintOrgToken",
      message: "platform oauth mint",
      data: { source: pair.source, status: res.status, ok: Boolean(body.access_token), err: body.error ?? null },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (!res.ok || !body.access_token) return { status: res.status };
  return { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

async function orgAccessToken(): Promise<string> {
  const pairs = credPairs();
  if (!pairs.length) throw new Error("AGENTCARD_CLIENT_ID / AGENTCARD_CLIENT_SECRET unset");
  if (orgToken && pairs.some((p) => p.id === orgToken!.clientId) && orgToken.exp > Date.now() + 30_000) {
    return orgToken.value;
  }
  orgToken = null;
  let lastStatus = 401;
  for (const pair of pairs) {
    const minted = await mintOrgToken(pair);
    if ("token" in minted) {
      orgToken = { value: minted.token, exp: minted.exp, clientId: pair.id };
      return minted.token;
    }
    lastStatus = minted.status;
  }
  throw new AgentCardLoginError(`AgentCard oauth failed (${lastStatus})`);
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
      if (res.status === 401 || res.status === 403) {
        throw new AgentCardLoginError(`AgentCard ${path} failed (${res.status})`);
      }
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

async function postWalletLinks(body: Record<string, string>): Promise<WalletLink> {
  const link = await api<WalletLink & { attach_url?: string }>("/api/v2/wallet_links", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const url = link.url || link.attach_url;
  if (!url) throw new Error("AgentCard wallet_links missing url");
  return { id: link.id, url, user_id: link.user_id };
}

/** Fresh wallet_links every call. Platform token only — never a user connection token. */
export async function createWalletLink(identity: string): Promise<WalletLink> {
  dropConnection(identity);
  try {
    return await postWalletLinks({ external_user_id: identity });
  } catch (e) {
    if (isAgentCardLoginError(e)) throw e;
    const conn = await connectIdentity(identity);
    return await postWalletLinks({ user_id: conn.userId });
  }
}

/** Hosted pay-sheet: platform token mints the wallet_link; user token never goes on this call. */
export async function createPaySheetLink(
  identity: string,
  merchant: string,
  amountCents: number,
): Promise<WalletLink> {
  const conn = getConnection(identity);
  if (!conn?.userId) {
    throw new AgentCardLoginError("PaySheet requires connected user");
  }
  const link = await postWalletLinks({ user_id: conn.userId });
  return { ...link, url: paySheetUrl(link.url, merchant, amountCents) };
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
