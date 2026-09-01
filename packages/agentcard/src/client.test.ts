import { afterEach, describe, expect, it, vi } from "vitest";
import { agentcardConfigured, mintPlatformToken } from "./client";

const saved = {
  id: process.env.AGENTCARD_CLIENT_ID,
  secret: process.env.AGENTCARD_CLIENT_SECRET,
};

afterEach(() => {
  if (saved.id === undefined) delete process.env.AGENTCARD_CLIENT_ID;
  else process.env.AGENTCARD_CLIENT_ID = saved.id;
  if (saved.secret === undefined) delete process.env.AGENTCARD_CLIENT_SECRET;
  else process.env.AGENTCARD_CLIENT_SECRET = saved.secret;
  vi.unstubAllGlobals();
});

describe("AgentCard platform token", () => {
  it("falls back to Anvil when AGENTCARD_* is unset", async () => {
    delete process.env.AGENTCARD_CLIENT_ID;
    delete process.env.AGENTCARD_CLIENT_SECRET;
    expect(agentcardConfigured()).toBe(false);
    expect(await mintPlatformToken()).toBe(false);
  });

  it("mints POST /api/v2/oauth/token when AGENTCARD_* is set", async () => {
    const clientId = `ac_test_${Date.now()}`;
    process.env.AGENTCARD_CLIENT_ID = clientId;
    process.env.AGENTCARD_CLIENT_SECRET = "ac_test_secret";
    process.env.AGENTCARD_API_BASE = "https://api.agentcard.sh";
    expect(agentcardConfigured()).toBe(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
});
