/**
 * "Connect with AgentCard" routes — framework-free handlers for the host's
 * node:http server (same style as @manebra/webhooks). Mount both on the
 * PUBLIC base that matches the registered redirect_uri:
 *   GET /api/agentcard/connect?user=<stable id>  → 302 to /authorize
 *   GET /api/agentcard/callback?code&state       → token exchange, stores tokens
 */
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  oauthConfigured,
  publicBase,
  takePendingState,
} from "./oauth";

export type OAuthRouteResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export function isAgentcardOAuthRequest(url: string): boolean {
  return url.startsWith("/api/agentcard/connect") || url.startsWith("/api/agentcard/callback");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>${esc(title)}</h2><p>${esc(detail)}</p></body>`;
}

const html = { "content-type": "text/html; charset=utf-8" };
const json = { "content-type": "application/json" };

export async function handleAgentcardOAuth(url: string): Promise<OAuthRouteResult> {
  const u = new URL(url, publicBase());

  if (u.pathname === "/api/agentcard/connect") {
    if (!oauthConfigured()) {
      return { status: 503, headers: json, body: JSON.stringify({ error: "AGENTCARD_OAUTH_CLIENT_ID unset" }) };
    }
    const user = u.searchParams.get("user")?.trim();
    if (!user) {
      return { status: 400, headers: json, body: JSON.stringify({ error: "missing user param" }) };
    }
    const location = await buildAuthorizeUrl(user);
    return { status: 302, headers: { location }, body: "" };
  }

  if (u.pathname === "/api/agentcard/callback") {
    const err = u.searchParams.get("error");
    if (err) {
      const detail = u.searchParams.get("error_description") ?? "";
      return { status: 400, headers: html, body: page("AgentCard sign-in failed", `${err}: ${detail}`) };
    }
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    if (!code || !state) {
      return { status: 400, headers: html, body: page("AgentCard sign-in failed", "missing code or state") };
    }
    const pending = takePendingState(state);
    if (!pending) {
      return { status: 400, headers: html, body: page("AgentCard sign-in failed", "unknown or expired state — start again from the chat link") };
    }
    try {
      await exchangeCodeForToken(pending.identity, code, pending.verifier);
    } catch (e: any) {
      console.error(`[agentcard] token exchange failed: ${e?.message ?? e}`);
      return { status: 502, headers: html, body: page("AgentCard sign-in failed", "token exchange failed — try the link again") };
    }
    return { status: 200, headers: html, body: page("AgentCard connected", "You’re linked. Head back to the chat and ask again.") };
  }

  return { status: 404, headers: json, body: JSON.stringify({ error: "not found" }) };
}
