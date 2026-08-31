/**
 * AGENTCARD SMOKE — live SANDBOX verification of the OAuth 2.1 + PKCE + MCP
 * integration. Exits non-zero on any failure.  Run: npm run smoke:agentcard
 *
 * 1. OAuth discovery (.well-known) matches the endpoints the code uses.
 * 2. Confidential-client proof: refresh WITHOUT client_secret is rejected as
 *    invalid_client; WITH the secret the client is accepted (bogus token fails
 *    later, as invalid_grant — never invalid_client).
 * 3. Org door (client_secret as the MCP bearer): dynamic tools/list, then
 *    cardholder + ONE sandbox card, independently verified via fresh list_cards.
 * 4. Per-user leg to the tap boundary (needs the shopper-agent on :8790):
 *    live /connect 302 → spec-correct authorize URL; callback rejects a forged
 *    state.  (The final tap is a human action — the URL is printed for it.)
 *
 * Never prints tokens, PANs, or CVVs.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
}

const { discover, mcpResource, publicBase, redirectUri } = await import("../packages/agentcard/src/oauth");
const { withOrgMcp } = await import("../packages/agentcard/src/mcp");

const clientId = process.env.AGENTCARD_OAUTH_CLIENT_ID?.trim();
const clientSecret = process.env.AGENTCARD_OAUTH_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) throw new Error("AGENTCARD_OAUTH_CLIENT_ID / AGENTCARD_OAUTH_CLIENT_SECRET unset");

const ok = (msg: string) => console.log(`✓ ${msg}`);

// ── 1. discovery ─────────────────────────────────────────────────────────────
const disco = await discover();
const meta = await (await fetch(`${mcpResource().replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource`)).json() as any;
if (!disco.authorization_endpoint.includes("/authorize")) throw new Error("bad authorization_endpoint");
if (!disco.token_endpoint.includes("/token")) throw new Error("bad token_endpoint");
ok(`discovery: authorize=${disco.authorization_endpoint} token=${disco.token_endpoint} resource meta ok=${Boolean(meta.resource)}`);

// ── 2. confidential refresh requires the secret ──────────────────────────────
async function tryRefresh(withSecret: boolean): Promise<{ status: number; error?: string }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: "rt_bogus_smoke",
    client_id: clientId!,
    resource: mcpResource(),
  });
  if (withSecret) body.set("client_secret", clientSecret!);
  const res = await fetch(disco.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: data.error };
}
const noSecret = await tryRefresh(false);
if (noSecret.status < 400 || noSecret.error !== "invalid_client") {
  throw new Error(`refresh WITHOUT secret should be invalid_client, got ${noSecret.status} ${noSecret.error}`);
}
const withSecret = await tryRefresh(true);
if (withSecret.error === "invalid_client") {
  throw new Error("refresh WITH secret rejected the client — wrong AGENTCARD_OAUTH_CLIENT_SECRET?");
}
ok(`confidential client enforced: without secret → ${noSecret.status} invalid_client; with secret → ${withSecret.status} ${withSecret.error ?? "ok"} (client accepted)`);

// ── 3. org door: cardholder + one sandbox card, independently verified ──────
const summary = await withOrgMcp(async (c) => {
  const tools = (await c.listTools()).tools;
  if (!tools.length) throw new Error("org tools/list came back empty");
  ok(`org MCP connected — ${tools.length} tools advertised dynamically: ${tools.map((t) => t.name).join(", ")}`);

  // Sandbox tools reply with prose + structuredContent (ids live in the latter).
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: any }> => {
    const res: any = await c.callTool({ name, arguments: args });
    const text: string = res.content?.map((p: any) => p.text ?? "").join("\n") ?? "";
    if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    return { text, data: res.structuredContent ?? {} };
  };
  const idIn = (text: string): string | undefined =>
    text.match(/\(([a-z0-9_-]{16,})\)/i)?.[1] ?? text.match(/\b(c[a-z0-9]{20,})\b/)?.[1];

  const who = await call("whoami");
  ok(`whoami: ${who.text.split("\n")[0]?.slice(0, 100)}`);

  const holder = await call("create_cardholder", {
    first_name: "Manebra",
    last_name: "Smoke",
    date_of_birth: "1990-01-15",
    email: `smoke+${Date.now()}@sandbox.manebra.local`,
  });
  const cardholderId = holder.data.cardholder?.id ?? holder.data.id ?? idIn(holder.text);
  if (!cardholderId) throw new Error(`create_cardholder returned no id: ${holder.text.slice(0, 200)}`);
  ok(`cardholder created: ${cardholderId}`);

  const createCard = () =>
    call("create_card", {
      cardholder_id: cardholderId,
      amount_cents: 500,
      idempotency_key: `manebra-smoke-${cardholderId}`,
    });
  const cardIdOf = (r: { text: string; data: any }): string | undefined =>
    r.data.card?.id ?? r.data.cardId ?? r.data.id ?? idIn(r.text);

  let card = await createCard();
  if (/kyc/i.test(card.text) && !cardIdOf(card)) {
    // Live gate: the cardholder must verify identity. In SANDBOX the hosted
    // verifier is in test mode and exposes a test-complete endpoint — the
    // stand-in for the human ID + face-scan steps. (Prod: hand the user the
    // link from start_cardholder_kyc and poll get_cardholder_kyc_status.)
    const kycStart = await call("start_cardholder_kyc", { cardholder_id: cardholderId });
    const verifyUrl = kycStart.data.verificationUrl ?? kycStart.text.match(/https?:\/\/\S+/)?.[0];
    if (!verifyUrl) throw new Error(`start_cardholder_kyc returned no link: ${kycStart.text.slice(0, 200)}`);
    const kycToken = new URL(verifyUrl).searchParams.get("token");
    const kycApi = (path: string, body: unknown) =>
      fetch(new URL(path, verifyUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${kycToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<any>);
    await kycApi("/kyc/verify/terms", { agreed: true });
    const done = await kycApi("/kyc/verify/test-complete", { outcome: "approved" });
    if (!done.verified) throw new Error(`sandbox KYC test-complete failed: ${JSON.stringify(done).slice(0, 200)}`);
    const status = await call("get_cardholder_kyc_status", { cardholder_id: cardholderId });
    ok(`cardholder KYC verified (sandbox test-mode): ${status.text.slice(0, 60)}`);
    card = await createCard();
  }
  if (/no payment method/i.test(card.text) && !cardIdOf(card)) {
    // Sandbox: setup_cardholder_payment_method attaches a simulated card.
    const pm = await call("setup_cardholder_payment_method", { cardholder_id: cardholderId });
    ok(`payment method attached (sandbox): ${pm.text.slice(0, 70)}`);
    card = await createCard();
  }
  // never print the raw payload — card details may include the PAN
  const cardId = cardIdOf(card);
  if (!cardId || cardId === cardholderId) {
    throw new Error(`create_card returned no recognizable card id: ${card.text.slice(0, 120)}`);
  }
  ok(`sandbox card issued: ${cardId}`);

  const listed = await call("list_cards", { cardholder_id: cardholderId });
  const listedIds: string[] = (listed.data.cards ?? []).map((x: any) => x.id);
  if (!listedIds.includes(cardId)) throw new Error("issued card missing from a fresh list_cards — NOT verified");
  ok(`independently verified via fresh list_cards: ${cardId} present (status ${(listed.data.cards ?? []).find((x: any) => x.id === cardId)?.status})`);
  return { cardholderId, cardId };
});

// ── 4. per-user leg to the tap boundary (agent must be running on :8790) ────
const connectUrl = `${publicBase()}/api/agentcard/connect?user=smoke-user`;
try {
  const res = await fetch(connectUrl, { redirect: "manual" });
  if (res.status !== 302) throw new Error(`/connect returned ${res.status}, want 302`);
  const loc = new URL(res.headers.get("location")!);
  const p = loc.searchParams;
  if (loc.toString().split("?")[0] !== disco.authorization_endpoint) throw new Error(`302 target ${loc.origin}${loc.pathname} != authorization_endpoint`);
  if (p.get("client_id") !== clientId) throw new Error("302 client_id mismatch");
  if (p.get("redirect_uri") !== redirectUri()) throw new Error("302 redirect_uri != registered redirect_uri");
  if (p.get("code_challenge_method") !== "S256") throw new Error("302 missing S256 PKCE");
  if (!p.get("code_challenge")) throw new Error("302 missing code_challenge");
  if (p.get("resource") !== mcpResource()) throw new Error("302 missing mandatory resource param");
  if (!p.get("state")) throw new Error("302 missing CSRF state");
  ok("live /connect → 302 with spec-correct authorize URL (exact redirect_uri, S256, resource, state)");

  const forged = await fetch(`${publicBase()}/api/agentcard/callback?code=x&state=forged-smoke`, { redirect: "manual" });
  if (forged.status !== 400) throw new Error(`callback with forged state returned ${forged.status}, want 400`);
  ok("live /callback rejects an unknown state (400)");
  console.log(`\nhuman tap boundary — to finish a real per-user connect, open:\n  ${connectUrl}`);
} catch (e: any) {
  if (/ECONNREFUSED|fetch failed/i.test(String(e?.message ?? e))) {
    console.error(`✗ per-user leg NOT verified — shopper-agent not running on ${publicBase()} (npm run shopper-agent)`);
    process.exit(1);
  }
  throw e;
}

console.log(`\nAGENTCARD SMOKE PASSED — cardholder ${summary.cardholderId}, card ${summary.cardId} (sandbox)`);
