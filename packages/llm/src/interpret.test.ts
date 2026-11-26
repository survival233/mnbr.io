import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpretReply, llmUnderstandingEnabled } from "./index.js";

function mockChat(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response),
  );
}

beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "sk-test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("interpretReply (LLM understanding fallback)", () => {
  it("is a no-op (null) unless LLM_UNDERSTANDING is enabled", async () => {
    expect(llmUnderstandingEnabled()).toBe(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await interpretReply({ message: "the 10th", asked: "When?", slot: "deadline", kind: "date" });
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("interprets an off-pattern answer into a normalized value", async () => {
    vi.stubEnv("LLM_UNDERSTANDING", "1");
    mockChat('{"action":"answer","value":"2027-01-10"}');
    const r = await interpretReply({ message: "second week of January", asked: "When by?", slot: "deadline", kind: "date" });
    expect(r).toEqual({ action: "answer", value: "2027-01-10" });
  });

  it("recognizes a status question", async () => {
    vi.stubEnv("LLM_UNDERSTANDING", "1");
    mockChat('{"action":"status"}');
    const r = await interpretReply({ message: "any news?", asked: "When by?", slot: "deadline", kind: "date" });
    expect(r?.action).toBe("status");
  });

  it("falls back to null on an LLM error so the caller keeps its rules", async () => {
    vi.stubEnv("LLM_UNDERSTANDING", "1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const r = await interpretReply({ message: "x", asked: "q", slot: "deadline", kind: "date" });
    expect(r).toBeNull();
  });
});
