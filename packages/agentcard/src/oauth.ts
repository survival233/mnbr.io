/**
 * AgentCard OAuth 2.1 + PKCE ("Connect with AgentCard").
 * Per-user access/refresh tokens for the AgentCard MCP server.
 *
 * Confidential client: AGENTCARD_OAUTH_CLIENT_SECRET rides on BOTH the code
 * exchange and the refresh. The `resource` param (the MCP server URL) is
 * mandatory on /authorize AND /token. Refresh ROTATES the refresh token —
 * the rotated token is persisted on every refresh.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MCP_BASE = () =>
  (process.env.AGENTCARD_API_URL?.trim() || "https://mcp.agentcard.sh").replace(/\/$/, "");

/** The protected resource — mandatory `resource` param everywhere. */
export function mcpResource(): string {
  return `${MCP_BASE()}/mcp`;
}

const clientId = () => process.env.AGENTCARD_OAUTH_CLIENT_ID?.trim();
const clientSecret = () => process.env.AGENTCARD_OAUTH_CLIENT_SECRET?.trim();

export function oauthConfigured(): boolean {
  return Boolean(clientId());
}

export function publicBase(): string {
  return (process.env.AGENTCARD_PUBLIC_URL?.trim() || "http://localhost:8790").replace(/\/$/, "");
}

/** Must equal the redirect_uri registered on the OAuth client, exactly. */
export function redirectUri(): string {
  return `${publicBase()}/api/agentcard/callback`;
}

// ── discovery (cached; falls back to the documented endpoints) ──────────────
type Discovery = { authorization_endpoint: string; token_endpoint: string };
let discovered: Discovery | null = null;

export async function discover(): Promise<Discovery> {
  if (discovered) return discovered;
  try {
    const res = await fetch(`${MCP_BASE()}/.well-known/oauth-authorization-server`);
    if (res.ok) {
      const d = (await res.json()) as Partial<Discovery>;
      if (d.authorization_endpoint && d.token_endpoint) {
        discovered = { authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint };
        return discovered;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  discovered = {
    authorization_endpoint: `${MCP_BASE()}/authorize`,
    token_endpoint: `${MCP_BASE()}/token`,
  };
  return discovered;
}

/** Test seam: forget cached discovery (endpoints can move between env setups). */
export function resetDiscoveryCache(): void {
  discovered = null;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────
export type Pkce = { verifier: string; challenge: string };

export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── per-user token store (same JSON-file pattern as client.ts) ──────────────
export type OAuthConnection = {
  identity: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when accessToken expires. */
  expiresAt: number;
};

type OAuthStore = { connections: OAuthConnection[] };

function storePath(): string {
  return process.env.AGENTCARD_OAUTH_STORE_PATH?.trim() || ".agentcard-oauth-store.json";
}

function loadStore(): OAuthStore {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as OAuthStore;
    return { connections: Array.isArray(raw.connections) ? raw.connections : [] };
  } catch {
    return { connections: [] };
  }
}

function saveStore(store: OAuthStore): void {
  const p = storePath();
  mkdirSync(dirname(p) === "." ? "." : dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2));
}

export function getOAuthConnection(identity: string): OAuthConnection | null {
  return loadStore().connections.find((c) => c.identity === identity) ?? null;
}

export function putOAuthConnection(row: OAuthConnection): void {
  const store = loadStore();
  const i = store.connections.findIndex((c) => c.identity === row.identity);
  if (i >= 0) store.connections[i] = row;
  else store.connections.push(row);
  saveStore(store);
}

export function isExpired(conn: OAuthConnection): boolean {
  return Date.now() > conn.expiresAt - 60_000;
}

// ── in-memory state → {identity, verifier} (CSRF + PKCE across the redirect) ─
const pendingStates = new Map<string, { identity: string; verifier: string; createdAt: number }>();
const STATE_TTL_MS = 10 * 60_000;

/** Mint PKCE + state for one user and build the /authorize URL. */
export async function buildAuthorizeUrl(identity: string): Promise<string> {
  const id = clientId();
  if (!id) throw new Error("AGENTCARD_OAUTH_CLIENT_ID unset");
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("base64url");
  pendingStates.set(state, { identity, verifier, createdAt: Date.now() });
  const { authorization_endpoint } = await discover();
  const u = new URL(authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", id);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", mcpResource());
  u.searchParams.set("state", state);
  return u.toString();
}

/** One-shot: consume a state minted by buildAuthorizeUrl. Unknown/expired → null. */
export function takePendingState(state: string): { identity: string; verifier: string } | null {
  const row = pendingStates.get(state);
  if (!row) return null;
  pendingStates.delete(state);
  if (Date.now() - row.createdAt > STATE_TTL_MS) return null;
  return { identity: row.identity, verifier: row.verifier };
}

// ── token endpoint calls ─────────────────────────────────────────────────────
type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
};

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const id = clientId();
  if (!id) throw new Error("AGENTCARD_OAUTH_CLIENT_ID unset");
  const { token_endpoint } = await discover();
  const body = new URLSearchParams({ ...params, client_id: id, resource: mcpResource() });
  const secret = clientSecret();
  if (secret) body.set("client_secret", secret); // confidential: exchange AND refresh
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(`agentcard ${params.grant_type} failed (${res.status}${data.error ? ` ${data.error}` : ""})`);
  }
  return data;
}

export async function exchangeCodeForToken(identity: string, code: string, verifier: string): Promise<OAuthConnection> {
  const t = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const row: OAuthConnection = {
    identity,
    accessToken: t.access_token!,
    refreshToken: t.refresh_token ?? "",
    expiresAt: Date.now() + (t.expires_in ?? 86400) * 1000,
  };
  putOAuthConnection(row);
  return row;
}

export async function refreshAccessToken(conn: OAuthConnection): Promise<OAuthConnection> {
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: conn.refreshToken });
  const row: OAuthConnection = {
    ...conn,
    accessToken: t.access_token!,
    // rotation: the server mints a new refresh token — keep the new one
    refreshToken: t.refresh_token ?? conn.refreshToken,
    expiresAt: Date.now() + (t.expires_in ?? 86400) * 1000,
  };
  putOAuthConnection(row);
  return row;
}
