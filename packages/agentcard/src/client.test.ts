import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentcardConfigured, createPaySheetLink, mintPlatformToken } from "./client";

const saved = {
  id: process.env.AGENTCARD_CLIENT_ID,
  secret: process.env.AGENTCARD_CLIENT_SECRET,
  oauthId: process.env.AGENTCARD_OAUTH_CLIENT_ID,
  oauthSecret: process.env.AGENTCARD_OAUTH_CLIENT_SECRET,
  store: process.env.AGENTCARD_STORE_PATH,
};

afterEach(() => {
  if (saved.id === undefined) delete process.env.AGENTCARD_CLIENT_ID;
  else process.env.AGENTCARD_CLIENT_ID = saved.id;
  if (saved.secret === undefined) delete process.env.AGENTCARD_CLIENT_SECRET;
  else process.env.AGENTCARD_CLIENT_SECRET = saved.secret;
  if (saved.oauthId === undefined) delete process.env.AGENTCARD_OAUTH_CLIENT_ID;
  else process.env.AGENTCARD_OAUTH_CLIENT_ID = saved.oauthId;
  if (saved.oauthSecret === undefined) delete process.env.AGENTCARD_OAUTH_CLIENT_SECRET;
  else process.env.AGENTCARD_OAUTH_CLIENT_SECRET = saved.oauthSecret;
  if (saved.store === undefined) delete process.env.AGENTCARD_STORE_PATH;
  else process.env.AGENTCARD_STORE_PATH = saved.store;
  vi.unstubAllGlobals();
});

describe("AgentCard platform token", () => {
  it("falls back to Anvil when AGENTCARD_* is unset", async () => {
    delete process.env.AGENTCARD_CLIENT_ID;
    delete process.env.AGENTCARD_CLIENT_SECRET;
    delete process.env.AGENTCARD_OAUTH_CLIENT_ID;
    delete process.env.AGENTCARD_OAUTH_CLIENT_SECRET;
    expect(agentcardConfigured()).toBe(false);
    expect(await mintPlatformToken()).toBe(false);
  });

  it("is configured when only AGENTCARD_OAUTH_* is set", () => {
    delete process.env.AGENTCARD_CLIENT_ID;
    delete process.env.AGENTCARD_CLIENT_SECRET;
    process.env.AGENTCARD_OAUTH_CLIENT_ID = "oauth-client";
    process.env.AGENTCARD_OAUTH_CLIENT_SECRET = "oauth-secret";
    expect(agentcardConfigured()).toBe(true);
  });

  it("mints POST /api/v2/oauth/token when AGENTCARD_* is set", async () => {
    const clientId = `ac_test_${Date.now()}`;
    process.env.AGENTCARD_CLIENT_ID = clientId;
    process.env.AGENTCARD_CLIENT_SECRET = "ac_test_secret";
    process.env.AGENTCARD_API_BASE = "https://api.agentcard.sh";
    expect(agentcardConfigured()).toBe(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("127.0.0.1")) return new Response("{}", { status: 204 });
      expect(url).toBe("https://api.agentcard.sh/api/v2/oauth/token");
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe(clientId);
      expect(body.get("client_secret")).toBeTruthy();
      return new Response(JSON.stringify({ access_token: "at_test", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await mintPlatformToken()).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("mints pay-sheet wallet_links with the platform token, not the user connection token", async () => {
    process.env.AGENTCARD_CLIENT_ID = "ac_pay_id";
    process.env.AGENTCARD_CLIENT_SECRET = "ac_pay_secret";
    process.env.AGENTCARD_API_BASE = "https://api.agentcard.sh";
    process.env.AGENTCARD_STORE_PATH = join(mkdtempSync(join(tmpdir(), "ac-pay-")), "store.json");
    writeFileSync(
      process.env.AGENTCARD_STORE_PATH,
      JSON.stringify({
        connections: [
          {
            identity: "usr_test",
            userId: "user_1",
            accessToken: "user_connection_token",
            refreshToken: "user_refresh",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("127.0.0.1")) return new Response("{}", { status: 204 });
      if (url.endsWith("/api/v2/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "platform_token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url).toBe("https://api.agentcard.sh/api/v2/wallet_links");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer platform_token");
      expect(headers.Authorization).not.toContain("user_connection_token");
      return new Response(
        JSON.stringify({ id: "wl_1", url: "https://app.agentcard.sh/w/wl_1.tok", user_id: "user_1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const link = await createPaySheetLink("usr_test", "Manebra", 12345);
    expect(new URL(link.url).searchParams.get("amount")).toBe("12345");
    expect(fetchMock).toHaveBeenCalled();
  });
});
