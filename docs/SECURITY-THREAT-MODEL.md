# MNBR — Security Threat Model

_Scope: the shopper & traveler agents, the shared marketplace, USDC escrow, and the
Agentcard/Relay/Linq integrations. Written for the product's current P2P form and its
near-term direction toward a broader agentic assistant (browser/tool use, more app
connections). Findings are grounded in the code as of this writing; file references are
clickable._

---

## 1. Assets worth protecting
1. **Escrow funds (USDC)** — the highest-value asset. Anything that can trigger "funded" or release a handover is money-critical.
2. **Payment instruments** — Agentcard-linked cards (shopper funding, traveler buying).
3. **User PII** — phones, chat content, delivery cities, Google Calendar/Gmail data (traveler).
4. **Secrets** — Relay/Linq/Agentcard tokens & webhook secrets, OAuth client secrets, SerpAPI key, DB URL.
5. **Agent integrity** — the agents act on the user's behalf and can move money; hijacking their decisions is the agentic-era crown jewel.

## 2. Trust boundaries (where untrusted data enters)
- **Inbound chat** over Relay/Linq — attacker-controlled text that reaches the LLM.
- **Webhooks** — Agentcard (payment), Relay, Linq, card updates. A forged webhook is a direct path to money.
- **Pasted product URLs** and **fetched store/web pages** — attacker-controlled content the server fetches and the LLM reads.
- **Marketplace rows** written by the counterparty agent (offer/trip state).

## 3. What is already done well (keep these invariants)
- **Money is gated by deterministic code, not the LLM.** Funding/escrow/handover run through the state machine in [`shopper-flow.mts`](apps/shopper-agent/src/shopper-flow.mts); no LLM tool can move funds. This is the single most important property — **do not** let a model tool call ever directly fund/release.
- **Traveler buy is capped in code.** [`fundedItemAndTaxCap`](apps/traveler-agent/src/traveler-flow.mts:183) bounds spend at item+tax; the system prompt is a backstop, not the control.
- **Webhook signatures** are HMAC-SHA256 with constant-time compare ([`verifyAgentCardSignature`](packages/webhooks/agentcard.ts:25)); Relay/Linq also verify.
- **Crypto hygiene:** handover codes use `randomInt` (CSPRNG), hashed + compared with `timingSafeEqual` ([`handover.ts`](packages/shared/src/handover.ts)); OAuth uses PKCE + random `state` ([`oauth.ts`](packages/agentcard/src/oauth.ts)).

---

## 4. Findings (prioritized)

### P0 — Webhook verification can fail **open** depending on `NODE_ENV` — ✅ FIXED
_Verification is now unconditional: a missing `AGENTCARD_WEBHOOK_SECRET` returns 500 and the signature is always required, independent of `NODE_ENV`. The Linq handler was hardened the same way (requires `LINQ_WEBHOOK_SECRET`). Covered by `packages/webhooks/agentcard.test.ts`._

[`handleAgentCardWebhook`](packages/webhooks/agentcard.ts:136) skips signature verification when
`AGENTCARD_WEBHOOK_SECRET` is unset, and only fails closed when `NODE_ENV === "production"`.
**`NODE_ENV` is not set anywhere** (not in `render.yaml`, the start command, or `package.json`).
Today the secret is set on Render, so it's fine — but the defense-in-depth is a single
misconfiguration away from accepting **unsigned payment webhooks**, i.e. a spoofed
"payment complete" that funds escrow / releases a handover.
- **Fix:** make verification unconditional — require the secret and reject if missing,
  regardless of `NODE_ENV`. Belt-and-suspenders: also set `NODE_ENV=production` on both
  Render services. Apply the same "secret required" rule to the Relay and Linq handlers.

### P0/P1 — SSRF in the catalog URL fetcher — ✅ FIXED
_Both fetch sinks now route through `safeFetchText` ([`net-guard.ts`](packages/catalog/src/net-guard.ts)): HTTP(S) only, host validated against private/loopback/link-local/metadata ranges before the request and after every redirect hop, redirects capped. The shopper sink additionally refuses to fetch anything that isn't a verified store. Residual: DNS-rebinding (TOCTOU) needs a pinned-lookup agent — tracked as follow-up. Covered by `packages/catalog/src/net-guard.test.ts`._

[`fetchProductUrlMeta`](packages/catalog/src/product-url.ts:134) does
`fetch(url, { redirect: "follow" })` on a URL that can originate from a user-pasted link,
with **no host/IP validation**. An attacker can point it (or redirect it) at
`http://169.254.169.254/` (cloud metadata), `localhost`, or internal services, and the
server will fetch them. This is exactly the risk the browser/agentic direction amplifies.
- **Fix:** before fetching and **after each redirect**, resolve the host and reject
  private/loopback/link-local/unique-local ranges; allow only `http(s)`; cap redirects
  (e.g. 2) and response size (already sliced to 400 KB — good); ideally **allow-list the
  verified store domains** since those are the only pages you legitimately parse.

### P1 — Prompt-injection surface will grow with the agentic direction
Both agents feed untrusted text to the LLM, and the traveler buy flow fetches store/web
content into a model turn ([`commerce-buy.mts`](apps/traveler-agent/src/commerce-buy.mts)).
Today the blast radius is contained because money is deterministic and the buy is capped.
Preserve that as you add browser/tool use:
- Keep **all money/irreversible actions behind deterministic gates + explicit human
  approval**, never behind a model tool call.
- Treat fetched page/email content as **data, not instructions** (delimit it, never
  concatenate into the system prompt).
- Keep the **buy cap hard-enforced in the tool bridge**, not the prompt.
- Reference: OWASP LLM Top-10 (LLM01 Prompt Injection, LLM06 Excessive Agency).

### P1 — Handover code brute-force / self-release — ✅ FIXED
_The traveler release path now requires the actual 6-digit code (a bare "done"/"confirm" no longer auto-releases using the stored code), compares it constant-time, and locks out after `HANDOVER_MAX_ATTEMPTS` (5) wrong tries per offer. Covered by `apps/traveler-agent/src/handover.test.ts`. Residual/follow-up: the code is still stored plaintext in `marketplace_offers.handover_code` (VarChar(32)); hashing it needs a schema migration (the deploy does not auto-run migrations), tracked separately._

### P1 (original) — Handover code brute-force (if submittable online)
6-digit code = 1,000,000 space. It's CSPRNG-generated, hashed, and constant-time compared
(good), and a code shown at a physical meeting is low-risk. But if a code can be **submitted
over chat/API to release escrow**, 1M is brute-forceable without a lockout.
- **Fix:** strict rate-limit + lockout on handover-code attempts per offer (e.g. 5 tries,
  then expire/re-issue); bind attempts to the specific offer and the authenticated party.

### P1 — Webhook replay protection — ✅ PARTIALLY FIXED
_`verifyAgentCardSignature` now rejects a signed request whose timestamp is older than 5 minutes, which bounds the replay window even if the in-memory idempotency set is lost. Covered by `packages/webhooks/agentcard.test.ts`. Residual/follow-up: cross-restart / cross-instance dedupe still needs a persistent (DB) idempotency store; deferred because the deploy does not auto-run migrations (Render runs a single instance, so the practical gap is only across restarts)._

### P1 (original) — Webhook replay protection is per-process and un-timed
Idempotency uses an in-memory `seen` set bounded at 4000 ([`agentcard.ts:53`](packages/webhooks/agentcard.ts:53)),
lost on restart and not shared across instances; the signed-timestamp variant parses `t`
but **never checks freshness**. A captured valid request could be replayed after a restart
or to another instance.
- **Fix:** persist processed event IDs (DB, with TTL) and enforce a timestamp tolerance
  (e.g. reject `t` older than 5 min).

### P2 — Secrets, OAuth, supply chain, PII
- **Secrets:** all via Render env (`sync:false`) — good. Add rotation runbooks and least
  privilege (scope Relay/Agentcard tokens). Never log card/token values.
- **OAuth (Google Calendar):** PKCE + `state` present; verify a strict `redirect_uri`
  allow-list, that stored tokens are encrypted at rest (a `tokenCipher` field exists —
  confirm the key management), and request **minimal scopes**.
- **Supply chain:** npm workspaces + CI→Render. Pin GitHub Actions to commit SHAs, enable
  lockfile integrity, and ensure `@manebra/*` internal packages can't be shadowed by a
  public-registry package (dependency confirmation / scoped registry).
- **PII minimization:** log IDs, not content; review what chat text is persisted in
  sessions and for how long.

---

## 5. For the agentic-platform (Muse-style) direction
As the agents gain a browser, more app connections, and tool-building, add:
- **Per-user isolation** for any browser/VM/tool execution (no shared execution context;
  treat container/VM escape as a first-class concern).
- **Capability gating:** each connected app/tool gets the narrowest scope; the agent
  cannot exceed what the user explicitly granted.
- **Formalized human-in-the-loop approval** for consequential actions (you already confirm
  money moves — make this a general, auditable gate).
- **Tamper-evident audit log** of planned/executed actions (append-only, integrity-checked).

---

## 6. Suggested order of work
1. P0 webhook fail-closed (`NODE_ENV` + unconditional secret). _Small, high impact._
2. P0/P1 SSRF guard in `fetchProductUrlMeta`.
3. P1 handover-code rate-limit/lockout.
4. P1 persistent webhook idempotency + timestamp tolerance.
5. P1 prompt-injection hardening pass (delimit fetched content; audit tool boundaries).
6. P2 secrets/OAuth/supply-chain/PII hardening.
