# @repo/agentcard

AgentCard integration for Manebra. Two independent surfaces:

1. **Pay-sheet** (`client.ts`, `PaySheet.ts`) — legacy hosted pay-sheet used by
   the shopper funding flow (`AGENTCARD_CLIENT_ID`/`AGENTCARD_CLIENT_SECRET`).
2. **"Connect with AgentCard"** (`oauth.ts`, `connect.ts`, `mcp.ts`) — OAuth 2.1
   + PKCE per-user tokens driving the AgentCard **MCP server**
   (`https://mcp.agentcard.sh/mcp`) so each chat user manages their own virtual
   cards through the agent.

## Client modes

- **Confidential** (this deployment): `AGENTCARD_OAUTH_CLIENT_ID` +
  `AGENTCARD_OAUTH_CLIENT_SECRET` minted via the AgentCard org endpoint. The
  secret is server-side only, is sent on **both** the code exchange and every
  refresh, and doubles as the **org MCP bearer** (`withOrgMcp`) and the
  `client_credentials` org credential. Never logged, never in client code.
- **Public (DCR)**: register via `POST /register` (no secret) and set only
  `AGENTCARD_OAUTH_CLIENT_ID`. All flows work identically minus the secret.

There are **no API keys** in this integration — the OAuth client credentials
are the org credential. Never mint or store `sk_test_`/`sk_live_` keys.

## Env vars

| Var | Meaning |
| --- | --- |
| `AGENTCARD_API_URL` | OAuth + MCP base (default `https://mcp.agentcard.sh`) |
| `AGENTCARD_PUBLIC_URL` | Public base of the shopper agent; `<base>/api/agentcard/callback` must equal the registered redirect_uri |
| `AGENTCARD_OAUTH_CLIENT_ID` | OAuth client id (public or confidential) |
| `AGENTCARD_OAUTH_CLIENT_SECRET` | Confidential secret / org bearer (optional for public clients) |
| `AGENTCARD_OAUTH_STORE_PATH` | Per-user token store (default `.agentcard-oauth-store.json`, gitignored) |

## Flow

1. User asks the shopper agent anything card-shaped → if not linked, the agent
   replies with `GET /api/agentcard/connect?user=<stable id>` (both routes are
   mounted on the shopper agent, port 8790).
2. `/connect` 302s to `/authorize` with S256 PKCE, CSRF `state`, and the
   mandatory `resource=https://mcp.agentcard.sh/mcp`; `/callback` validates the
   state and exchanges the code. Tokens are stored per user; refresh rotates
   the refresh token and the rotation is persisted.
3. Card turns run a multi-step LLM tool loop over the **live** MCP toolset:
   `tools/list` is fetched at runtime and forwarded **in full** — never a
   hardcoded or curated subset, so server-side tool additions need no code
   change here. 401s trigger one refresh + retry.
4. `kyc_required` is conversational (start_kyc → documents/fields → browser
   face scan via `verificationUrl` → `get_kyc_status`), never a retry loop.
   Org-managed cardholders get a scoped end-user token via `mint_buy_token`.

Card results may contain PAN/CVV: tool results are never logged (tool *names*
only); anything that must be printed goes through `redactCardContent`.

## Tests / smoke

- `npm test -w @repo/agentcard` — PKCE, token exchange/refresh (mock `/token`,
  asserts `resource`, `code_verifier`, `client_secret`, rotation), MCP against
  a mock server including an **invented future tool** (dynamic-toolset proof),
  approval gate, 401-refresh-retry, org door, redaction.
- `npm run smoke:agentcard` — live SANDBOX: discovery, with/without-secret
  refresh proof, org-door cardholder + card independently verified via fresh
  `list_cards`, and the per-user `/connect` 302 + forged-state rejection
  against the running agent (start it with `npm run shopper-agent`).
