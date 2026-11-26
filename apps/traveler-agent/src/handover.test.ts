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
const { releaseSpy } = vi.hoisted(() => ({ releaseSpy: vi.fn(async () => ({ txHash: "0x1" })) }));
vi.mock("@manebra/settlement/server/local-escrow", () => ({ settleLocalEscrow: releaseSpy }));

import { handleInbound } from "./traveler-flow.mts";
import { getOrCreateSession, persistSessionsNow } from "./session.mts";
import { writeOffer, getOffer } from "@manebra/db";

const dir = mkdtempSync(join(tmpdir(), "traveler-handover-"));
beforeAll(() => {
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [] }));
  vi.stubEnv("TRAVELER_SESSIONS_PATH", join(dir, "sessions.json"));
  vi.stubEnv("DEMO_MARKETPLACE_PATH", join(dir, "marketplace.json"));
  vi.stubEnv("DATABASE_URL", "");
});
afterEach(() => releaseSpy.mockClear());
afterAll(() => {
  persistSessionsNow();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function seedFundedOffer(id: string, phone: string, code: string) {
  await writeOffer({
    id,
    travelerId: phone,
    travelerName: "T",
    item: "iPhone 16 Pro",
    itemCostCents: 100_000,
    travelerFeeCents: 2_000,
    totalCents: 120_000,
    needBy: null,
    destinationCity: "Accra",
    bidId: id,
    escrowId: "0xabc",
    handoverCode: code,
    status: "funded",
    shopperKey: "shop1",
    shopperChatId: null,
    notifiedShopper: true,
    notifiedTraveler: true,
    notifiedTravelerFunded: true,
    nextTravelerId: null,
    nextTravelerName: null,
  } as Parameters<typeof writeOffer>[0]);
  const s = getOrCreateSession(phone, `chat_${phone}`, { channel: "relay" });
  s.stay = { lastOfferId: id };
  return s;
}

describe("handover-code release", () => {
  it("does NOT release on a bare 'done' — the real 6-digit code is required", async () => {
    const s = await seedFundedOffer("off_done", "+trav_done", "654321");
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "done", channel: "relay" });
    expect(releaseSpy).not.toHaveBeenCalled();
    expect((await getOffer("off_done"))?.status).toBe("funded");
  });

  it("releases escrow on the correct code", async () => {
    const s = await seedFundedOffer("off_ok", "+trav_ok", "654321");
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "654321", channel: "relay" });
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect((await getOffer("off_ok"))?.status).toBe("released");
  });

  it("locks out after the max wrong attempts and never releases", async () => {
    const s = await seedFundedOffer("off_bad", "+trav_bad", "654321");
    for (let i = 0; i < 5; i++) {
      await handleInbound({ phone: s.phone, chatId: s.chatId, text: "000000", channel: "relay" });
    }
    // Even a correct code is refused once locked out.
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "654321", channel: "relay" });
    expect(releaseSpy).not.toHaveBeenCalled();
    expect((await getOffer("off_bad"))?.status).toBe("funded");
  }, 20_000);
});
