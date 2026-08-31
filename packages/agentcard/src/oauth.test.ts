import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let base: string;
/** Every form body POSTed to the mock /token, in order. */
const tokenBodies: URLSearchParams[] = [];
let refreshGrantCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/token" && req.method === "POST") {
        const body = new URLSearchParams(raw);
        tokenBodies.push(body);
        const grant = body.get("grant_type");
        res.writeHead(200, { "content-type": "application/json" });
        if (grant === "refresh_token") {
          refreshGrantCount += 1;
          res.end(JSON.stringify({
            access_token: `at_refreshed_${refreshGrantCount}`,
            refresh_token: `rt_rotated_${refreshGrantCount}`,
            token_type: "bearer",
            expires_in: 86400,
          }));
        } else {
          res.end(JSON.stringify({
            access_token: "at_initial",
            refresh_token: "rt_initial",
            token_type: "bearer",
            expires_in: 86400,
          }));
        }
        return;
      }
      // .well-known → 404 so the module falls back to <base>/authorize|/token
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  process.env.AGENTCARD_API_URL = base;
  process.env.AGENTCARD_PUBLIC_URL = "http://localhost:8790";
  process.env.AGENTCARD_OAUTH_CLIENT_ID = "client-test-id";
  process.env.AGENTCARD_OAUTH_CLIENT_SECRET = "acs_test_secret";
  process.env.AGENTCARD_OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), "ac-oauth-")), "store.json");
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

// import AFTER env is prepared (module reads env lazily, but keep discovery clean)
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkce,
  getOAuthConnection,
  isExpired,
  mcpResource,
  putOAuthConnection,
  refreshAccessToken,
  resetDiscoveryCache,
  takePendingState,
} from "./oauth";
import { handleAgentcardOAuth } from "./connect";

describe("PKCE", () => {
  it("challenge is base64url(sha256(verifier)), S256", () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, no padding
  });
});

describe("authorize URL", () => {
  it("carries client_id, exact redirect_uri, S256 challenge, mandatory resource, state", async () => {
    resetDiscoveryCache();
    const url = new URL(await buildAuthorizeUrl("+15550001111"));
    expect(url.origin + url.pathname).toBe(`${base}/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-test-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8790/api/agentcard/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("resource")).toBe(mcpResource());
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(10);
    // state is one-shot
    const pending = takePendingState(state);
    expect(pending?.identity).toBe("+15550001111");
    expect(takePendingState(state)).toBeNull();
  });
});

describe("token exchange (confidential)", () => {
  it("sends grant_type, code_verifier, resource AND client_secret", async () => {
    const authorize = new URL(await buildAuthorizeUrl("+15550002222"));
    const state = authorize.searchParams.get("state")!;
    const pending = takePendingState(state)!;
    const conn = await exchangeCodeForToken("+15550002222", "code_abc", pending.verifier);

    const body = tokenBodies.at(-1)!;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code_abc");
    expect(body.get("code_verifier")).toBe(pending.verifier);
    expect(body.get("redirect_uri")).toBe("http://localhost:8790/api/agentcard/callback");
    expect(body.get("client_id")).toBe("client-test-id");
    expect(body.get("client_secret")).toBe("acs_test_secret");
    expect(body.get("resource")).toBe(mcpResource());

    expect(conn.accessToken).toBe("at_initial");
    expect(getOAuthConnection("+15550002222")?.refreshToken).toBe("rt_initial");
    expect(isExpired(conn)).toBe(false);
  });
});

describe("refresh (confidential, rotating)", () => {
  it("sends client_secret + resource and persists the ROTATED refresh token", async () => {
    putOAuthConnection({
      identity: "+15550003333",
      accessToken: "at_stale",
      refreshToken: "rt_old",
      expiresAt: Date.now() - 1000,
    });
    const conn = await refreshAccessToken(getOAuthConnection("+15550003333")!);

    const body = tokenBodies.at(-1)!;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_old");
    expect(body.get("client_secret")).toBe("acs_test_secret");
    expect(body.get("resource")).toBe(mcpResource());

    expect(conn.refreshToken).toMatch(/^rt_rotated_/);
    // rotation persisted to disk, not just in memory
    const onDisk = JSON.parse(readFileSync(process.env.AGENTCARD_OAUTH_STORE_PATH!, "utf8"));
    const row = onDisk.connections.find((c: any) => c.identity === "+15550003333");
    expect(row.refreshToken).toBe(conn.refreshToken);
  });
});

describe("callback route", () => {
  it("rejects an unknown state", async () => {
    const res = await handleAgentcardOAuth("/api/agentcard/callback?code=x&state=forged");
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/unknown or expired state/);
  });

  it("surfaces provider errors", async () => {
    const res = await handleAgentcardOAuth(
      "/api/agentcard/callback?error=access_denied&error_description=user%20cancelled",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/access_denied/);
  });

  it("connect 302s to a spec-correct authorize URL", async () => {
    const res = await handleAgentcardOAuth("/api/agentcard/connect?user=%2B15550004444");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location!);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("resource")).toBe(mcpResource());
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8790/api/agentcard/callback");
  });
});
