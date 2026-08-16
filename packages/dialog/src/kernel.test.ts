import { describe, expect, it } from "vitest";
import { classifyTurn } from "./classify";
import { composeHostReply } from "./reply";
import type { DialogSession } from "./types";

function sess(partial: Partial<DialogSession>): DialogSession {
  return { step: "idle", shoppingCity: "New York", pending: null, ...partial };
}

describe("stay + classify — a return is not a new job", () => {
  it("open stay + short dependent utterance is not NEW", () => {
    const s = sess({
      step: "await_traveler_decision",
      searchQuery: "PS5",
      stay: { lastItem: "PS5", lastTravelerName: "Ama", lastQuestion: "I’ll ping you when they agree.", waitingSince: Date.now() - 120_000 },
    });
    expect(classifyTurn(s, { text: "hmm" }).act).not.toBe("NEW");
  });

  it("open stay + META wait is not NEW", () => {
    const s = sess({
      step: "await_traveler_decision",
      stay: { lastItem: "PS5", lastOfferId: "req-1", waitingSince: Date.now() },
    });
    const t = classifyTurn(s, { text: "status" });
    expect(t.act).toBe("META");
    expect(t.act).not.toBe("NEW");
  });
});

describe("composeHostReply — act first, then the slot", () => {
  it("CONTINUE is not only the next field", () => {
    const beats = composeHostReply({
      act: "CONTINUE",
      stay: { lastItem: "PS5" },
      next: "Need it by 15th August?",
    });
    expect(beats.length).toBe(2);
    expect(beats[1]).toBe("Need it by 15th August?");
  });

  it("META wait names the stay, not a fresh intake", () => {
    const beats = composeHostReply({
      act: "META",
      meta: "wait",
      stay: { lastItem: "PS5", lastTravelerName: "Ama", waitingSince: Date.now() - 180_000 },
    });
    expect(beats.join(" ")).toMatch(/PS5/);
    expect(beats.join(" ")).not.toMatch(/What should I shop/);
  });
});
