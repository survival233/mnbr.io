/**
 * AgentCard MCP client (Streamable HTTP) — card tools per END USER, plus the
 * org door for server-side operations.
 *
 * The toolset is DYNAMIC: tools/list is fetched at runtime and forwarded in
 * full — never hardcode or curate tool names, so tools AgentCard adds later
 * work with zero code change here.
 *
 * NEVER log tool results verbatim — card details (PAN/CVV) may be inside.
 * Use redactCardContent() on anything that must be logged.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  getOAuthConnection,
  isExpired,
  mcpResource,
  refreshAccessToken,
  type OAuthConnection,
} from "./oauth";

export type CardTool = {
  name: string;
  description: string;
  /** JSON Schema, passed through verbatim from tools/list. */
  inputSchema: Record<string, unknown>;
};

async function openMcp(bearer: string): Promise<Client> {
  const client = new Client({ name: "manebra", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpResource()), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport); // initialize → notifications/initialized; session id echoed by the transport
  return client;
}

async function withMcp<T>(bearer: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await openMcp(bearer);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function looksUnauthorized(e: unknown): boolean {
  return /\b401\b|unauthorized|invalid[_ ]token/i.test(String((e as any)?.message ?? e));
}

/** Run fn with the user's bearer; refresh on near-expiry and once on 401. */
export async function withUserMcp<T>(identity: string, fn: (c: Client) => Promise<T>): Promise<T> {
  let conn: OAuthConnection | null = getOAuthConnection(identity);
  if (!conn) throw new Error(`agentcard: ${identity} is not connected`);
  if (isExpired(conn) && conn.refreshToken) conn = await refreshAccessToken(conn);
  try {
    return await withMcp(conn.accessToken, fn);
  } catch (e) {
    if (!looksUnauthorized(e) || !conn.refreshToken) throw e;
    conn = await refreshAccessToken(conn);
    return await withMcp(conn.accessToken, fn);
  }
}

/** The FULL live toolset — every tool the server advertises, no curation. */
export async function listCardTools(identity: string): Promise<CardTool[]> {
  return withUserMcp(identity, async (c) => {
    const res = await c.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    }));
  });
}

export async function callCardTool(
  identity: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return withUserMcp(identity, (c) => c.callTool({ name, arguments: args }));
}

/**
 * Org door: the raw confidential client_secret IS the org bearer on /mcp
 * (org-scoped tools — create_cardholder, whoami, create_card with a
 * cardholderId…). Server-side only; never expose to end users.
 */
export async function withOrgMcp<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const secret = process.env.AGENTCARD_OAUTH_CLIENT_SECRET?.trim();
  if (!secret) throw new Error("AGENTCARD_OAUTH_CLIENT_SECRET unset");
  return withMcp(secret, fn);
}

/** Mask PAN-length digit runs and CVV fields before anything is logged. */
export function redactCardContent(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, "•••• [redacted PAN]")
    .replace(/("(?:cvv|cvc|cvv2|securityCode)"\s*:\s*")[^"]+(")/gi, "$1•••$2");
}
