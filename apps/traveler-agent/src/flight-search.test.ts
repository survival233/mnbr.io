import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@prisma/client", () => ({ PrismaClient: class {}, Prisma: {} }));
vi.mock("./relay-client.mts", () => ({
  sendText: vi.fn(async () => ({})),
  startTyping: vi.fn(),
  stopTyping: vi.fn(),
  markRead: vi.fn(),
}));

import { handleInbound } from "./traveler-flow.mts";
import { getOrCreateSession, persistSessionsNow } from "./session.mts";
import * as relay from "./relay-client.mts";

const dir = mkdtempSync(join(tmpdir(), "traveler-flights-"));
beforeAll(() => {
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [] }));
  vi.stubEnv("TRAVELER_SESSIONS_PATH", join(dir, "sessions.json"));
  vi.stubEnv("SERPAPI_API_KEY", ""); // no key → deterministic demo flight provider
});
afterEach(() => vi.mocked(relay.sendText).mockClear());
afterAll(() => {
  persistSessionsNow();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function sentText(): string {
  return vi.mocked(relay.sendText).mock.calls.map((c: any) => c[0]?.text ?? "").join("\n");
}

describe("traveler flight search + deeplink booking", () => {
  it("shows flight options for a complete trip, then hands off a booking deeplink", async () => {
    const s = getOrCreateSession("+flt", "chat_flt", { channel: "relay" });
    s.trip = {
      origin: "New York",
      destination: "Accra",
      departure_date: "2031-01-15",
      confirmed: ["origin", "destination", "departure_date"],
      updated_at: 1,
    };
    s.step = "await_travel_intent";

    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "book a flight", channel: "relay" });
    expect(sentText()).toMatch(/Accra/);
    expect(sentText()).toMatch(/→/);
    expect(s.step).toBe("await_flight_pick");

    vi.mocked(relay.sendText).mockClear();
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "1", channel: "relay" });
    expect(sentText()).toMatch(/google\.com\/travel\/flights/);
    expect(s.selectedFlight).toBeTruthy();
  }, 25_000);

  it("skips to the opt-in without a link when the traveler says skip", async () => {
    const s = getOrCreateSession("+flt_skip", "chat_flt_skip", { channel: "relay" });
    s.trip = {
      origin: "New York",
      destination: "Accra",
      departure_date: "2031-01-15",
      confirmed: ["origin", "destination", "departure_date"],
      updated_at: 1,
    };
    s.step = "await_travel_intent";

    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "book a flight", channel: "relay" });
    vi.mocked(relay.sendText).mockClear();
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "skip", channel: "relay" });
    expect(sentText()).not.toMatch(/google\.com\/travel\/flights/);
    expect(s.step).toBe("await_shop_opt_in");
  }, 25_000);
});
