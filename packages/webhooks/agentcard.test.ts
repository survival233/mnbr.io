import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { handleAgentCardWebhook, verifyAgentCardSignature } from "./agentcard.js";

afterEach(() => vi.unstubAllEnvs());

const body = JSON.stringify({ id: `evt_${Math.random()}`, type: "unknown.event" });

describe("handleAgentCardWebhook — fail closed", () => {
  it("rejects with 500 when the secret is not configured (never accepts unsigned)", async () => {
    vi.stubEnv("AGENTCARD_WEBHOOK_SECRET", "");
    const r = await handleAgentCardWebhook(body, {});
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });

  it("rejects with 401 when the signature is missing or wrong", async () => {
    vi.stubEnv("AGENTCARD_WEBHOOK_SECRET", "s3cr3t");
    expect((await handleAgentCardWebhook(body, {})).status).toBe(401);
    expect((await handleAgentCardWebhook(body, { "agentcard-signature": "sha256=deadbeef" })).status).toBe(401);
  });

  it("accepts a correctly signed request", async () => {
    vi.stubEnv("AGENTCARD_WEBHOOK_SECRET", "s3cr3t");
    const sig = "sha256=" + createHmac("sha256", "s3cr3t").update(body).digest("hex");
    const r = await handleAgentCardWebhook(body, { "agentcard-signature": sig });
    expect(r.ok).toBe(true);
  });
});

describe("verifyAgentCardSignature", () => {
  it("is false for a missing signature header", () => {
    expect(verifyAgentCardSignature("s", "{}", undefined)).toBe(false);
  });
});
