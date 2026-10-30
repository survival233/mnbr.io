import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("@prisma/client", () => ({ PrismaClient: class {}, Prisma: {} }));
vi.mock("./relay-client.mts", () => ({ sendText: vi.fn(async () => ({})), startTyping: vi.fn(), stopTyping: vi.fn(), markRead: vi.fn() }));
vi.mock("@repo/agentcard", async (original) => {
  const actual = await original<typeof import("@repo/agentcard")>();
  return { ...actual, agentcardConfigured: vi.fn(() => true), createWalletLink: vi.fn(async () => ({ url: "https://example.test/wallet" })), PaySheet: vi.fn(async () => ({ url: "https://example.test/pay", amountCents: 1500 })), getConnection: vi.fn(() => null), resetPaymentIdentity: vi.fn() };
});
import { handleInbound, syncWaitingShoppers, attachWebhookCardToWaitingShoppers, completeAgentCardPayment } from "./shopper-flow.mts";
import { getOrCreateSession, persistSessionsNow, allSessions } from "./session.mts";
import { createWalletLink, resetPaymentIdentity, PaySheet } from "@repo/agentcard";
import { setConnectedCard, getConnectedCard } from "@manebra/db";
import * as relay from "./relay-client.mts";
import { recapHash } from "@manebra/dialog";
const dir = mkdtempSync(join(tmpdir(), "shopper-regression-"));
beforeAll(() => {
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: { usr_legacy: { phone: "usr_legacy", chatId: "cnv_legacy", channel: "relay", step: "await_product", updatedAt: 1 } } }));
  vi.stubEnv("SHOPPER_SESSIONS_PATH", join(dir, "sessions.json"));
  vi.stubEnv("AGENTCARD_CARDS_PATH", join(dir, "cards.json"));
  vi.stubEnv("DEMO_LOCAL_CHAIN", "0");
});
afterAll(() => { persistSessionsNow(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => vi.clearAllMocks());
function recap(identity: string) {
  const s = getOrCreateSession(identity, `chat_${identity}`, { channel: "relay" });
  Object.assign(s, {
    step: "await_pay_confirm", deliveryCity: "Accra", maxFeeCents: 500,
    selected: { listingId: "test:1", productTitle: "Book", storeName: "Test", priceCents: 1000, taxCents: 0, includesTax: true },
    cart: { listingId: "test:1", qty: 1 },
    recapHash: recapHash({ sku: "test:1", qty: 1, itemCents: 1000, taxCents: 0, earningsCents: 500, totalCents: 1500, handoverCity: "Accra" }),
    pending: { slot: "pay", kind: "bool", proposed: null, prompt: "Send the pay sheet?" },
  });
  return s;
}
describe("shopper payment replies", () => {
  it("starts one wallet handoff after recap yes, and keeps it for subsequent replies", async () => {
    const s = recap("usr_payment_one");
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "yes", channel: "relay" });
    expect(createWalletLink).toHaveBeenCalledTimes(1);
    expect(s.walletLinkSent).toBe(true);
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "yes", channel: "relay" });
    expect(createWalletLink).toHaveBeenCalledTimes(1);
    expect(resetPaymentIdentity).not.toHaveBeenCalled();
  });
  it("does not open a wallet on an unconfirmed recap or an ordinary re-ask", async () => {
    const s = recap("usr_payment_changed");
    s.recapHash = "outdated";
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "yes", channel: "relay" });
    expect(createWalletLink).not.toHaveBeenCalled();
    expect(s.walletLinkSent).not.toBe(true);
  });
  it("honors a failed handoff cooldown without resetting the identity", async () => {
    const s = recap("usr_payment_retry");
    s.walletHandoffFailed = true;
    s.walletRetryAt = Date.now() + 60_000;
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "yes", channel: "relay" });
    expect(createWalletLink).not.toHaveBeenCalled();
    expect(resetPaymentIdentity).not.toHaveBeenCalled();
  });
});

describe("shopper group sessions and dates", () => {
  it("keeps different people and different conversations isolated", () => {
    const a = getOrCreateSession("usr_alice", "cnv_group", { channel: "relay" });
    a.step = "await_pay_confirm";
    const b = getOrCreateSession("usr_bob", "cnv_group", { channel: "relay" });
    const elsewhere = getOrCreateSession("usr_alice", "cnv_other", { channel: "relay" });
    expect(b).not.toBe(a);
    expect(b.step).toBe("idle");
    expect(elsewhere).not.toBe(a);
    expect(getOrCreateSession("usr_alice", "cnv_group")).toBe(a);
    expect(a.phone).toBe("usr_alice");
  });
  it("shows a navigable delivery month and commits its selected day", async () => {
    const s = recap("usr_dates");
    s.step = "await_deadline";
    s.pending = { slot: "need_by", kind: "date", proposed: null, prompt: "When do you need it by?" };
    s.datePickerMonth = "2030-12";
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "next month", channel: "relay" });
    expect(relay.sendText).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("January 2031") }));
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "15", channel: "relay" });
    expect(s.deadline?.getFullYear()).toBe(2031);
    expect(s.deadline?.getMonth()).toBe(0);
    expect(s.deadline?.getDate()).toBe(15);
    expect(s.step).not.toBe("await_deadline");
  });
});

describe("background payment recovery", () => {
  it("does not start a pay sheet before recap consent even with a saved card", async () => {
    const s = recap("usr_unconfirmed_card");
    await setConnectedCard({ identity: s.phone, isDefault: true });
    await syncWaitingShoppers();
    expect(PaySheet).not.toHaveBeenCalled();
    expect(createWalletLink).not.toHaveBeenCalled();
  });
  it("does not replace wallet links every sync tick when the pay sheet fails", async () => {
    const s = recap("usr_card_failed_sheet");
    s.walletLinkSent = true;
    s.walletLinkSentAt = Date.now();
    s.paySheetAmountCents = 1500;
    await setConnectedCard({ identity: s.phone, isDefault: true });
    vi.mocked(PaySheet).mockRejectedValueOnce(new Error("payment service unavailable"));
    await syncWaitingShoppers();
    await syncWaitingShoppers();
    await handleInbound({ phone: s.phone, chatId: s.chatId, text: "yes", channel: "relay" });
    expect(PaySheet).toHaveBeenCalledTimes(1);
    expect(createWalletLink).not.toHaveBeenCalled();
    expect(s.walletHandoffFailed).toBe(true);
    expect(s.walletRetryAt).toBeGreaterThan(Date.now());
  });
});

it("migrates saved identity keys without duplicating background work", () => {
  const restored = getOrCreateSession("usr_legacy", "cnv_legacy", { channel: "relay" });
  expect(restored.step).not.toBe("idle");
  expect(allSessions().filter((s) => s.phone === "usr_legacy")).toHaveLength(1);
});

it("scopes card webhooks to their owner instead of every waiting participant", async () => {
  const a = recap("usr_webhook_a");
  const b = recap("usr_webhook_b");
  await attachWebhookCardToWaitingShoppers();
  expect(await getConnectedCard(a.phone)).toBeNull();
  await attachWebhookCardToWaitingShoppers(a.phone);
  expect(await getConnectedCard(a.phone)).not.toBeNull();
  expect(await getConnectedCard(b.phone)).toBeNull();
  b.paySheetSent = true;
  await completeAgentCardPayment();
  expect(b.funded).not.toBe(true);
});
