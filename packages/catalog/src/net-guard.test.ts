import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, safeFetchText } from "./net-guard.js";

afterEach(() => vi.unstubAllGlobals());

describe("assertPublicUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/scheme/);
    await expect(assertPublicUrl("ftp://example.com")).rejects.toThrow(/scheme/);
  });

  it("rejects literal private / loopback / metadata IPs", async () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::1]/",
    ]) {
      await expect(assertPublicUrl(u), u).rejects.toThrow(/blocked/);
    }
  });

  it("allows a public IP literal", async () => {
    await expect(assertPublicUrl("https://1.1.1.1/")).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetchText", () => {
  it("never calls fetch for a blocked host", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(safeFetchText("http://169.254.169.254/")).rejects.toThrow(/blocked/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-validates the host after a redirect to an internal address", async () => {
    const spy = vi.fn(async (u: string) =>
      u.includes("1.1.1.1")
        ? ({ status: 302, ok: false, headers: new Headers({ location: "http://169.254.169.254/" }), url: u, text: async () => "" } as unknown as Response)
        : ({ status: 200, ok: true, headers: new Headers(), url: u, text: async () => "ok" } as unknown as Response),
    );
    vi.stubGlobal("fetch", spy);
    await expect(safeFetchText("https://1.1.1.1/start")).rejects.toThrow(/blocked/);
  });
});
