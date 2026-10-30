import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("@prisma/client", () => ({ PrismaClient: class {}, Prisma: {} }));
vi.mock("./relay-client.mts", () => ({ sendText: vi.fn(async () => ({})), startTyping: vi.fn(), stopTyping: vi.fn(), markRead: vi.fn() }));
import { handleInbound } from "./traveler-flow.mts";
import * as relay from "./relay-client.mts";
import { getOrCreateSession, persistSessionsNow, allSessions } from "./session.mts";
const dir = mkdtempSync(join(tmpdir(), "traveler-sessions-"));
beforeAll(() => {
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { phone: "usr_legacy", chatId: "cnv_legacy", channel: "relay", step: "await_travel_intent", pending: { slot: "departure_date", kind: "date", proposed: null, prompt: "When?" }, datePickerMonth: "2030-12", trip: { destination: "Accra", confirmed: ["destination"], updated_at: 1 }, updatedAt: 1 },
    { phone: "usr_legacy", chatId: "cnv_legacy2", channel: "relay", step: "await_travel_intent", trip: { destination: "Lagos", confirmed: ["destination"], updated_at: 1 }, updatedAt: 1 }
  ] }));
  vi.stubEnv("TRAVELER_SESSIONS_PATH", join(dir, "sessions.json"));
});
afterAll(() => { persistSessionsNow(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
it("isolates participants and conversations without losing continuation", () => {
  const a = getOrCreateSession("usr_alice", "cnv_group", { channel: "relay" });
  a.trip!.destination = "Accra";
  const b = getOrCreateSession("usr_bob", "cnv_group", { channel: "relay" });
  expect(b).not.toBe(a);
  expect(b.trip?.destination).not.toBe("Accra");
  expect(getOrCreateSession("usr_alice", "cnv_other")).not.toBe(a);
  expect(getOrCreateSession("usr_alice", "cnv_group")).toBe(a);
  expect(a.phone).toBe("usr_alice");
});

it("navigates a flight month and commits its selected departure date", async () => {
  const s = getOrCreateSession("usr_flight_dates", "cnv_flight", { channel: "relay" });
  s.step = "await_travel_intent";
  s.pending = { slot: "departure_date", kind: "date", proposed: null, prompt: "When are you flying?" };
  s.datePickerMonth = "2030-12";
  await handleInbound({ phone: s.phone, chatId: s.chatId, text: "next month", channel: "relay" });
  expect(relay.sendText).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("January 2031") }));
  await handleInbound({ phone: s.phone, chatId: s.chatId, text: "15", channel: "relay" });
  expect(s.trip?.departure_date).toBe("2031-01-15");
  expect(s.pending?.slot).toBe("destination");
});

it("migrates saved identity keys without duplicating background work", () => {
  const restored = getOrCreateSession("usr_legacy", "cnv_legacy", { channel: "relay" });
  expect(restored.step).not.toBe("idle");
  expect(restored.datePickerMonth).toBe("2030-12");
  expect(restored.pending?.kind).toBe("date");
  expect(getOrCreateSession("usr_legacy", "cnv_legacy2").trip?.destination).toBe("Lagos");
  expect(allSessions().filter((s) => s.phone === "usr_legacy")).toHaveLength(2);
});
