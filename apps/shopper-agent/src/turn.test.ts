import { describe, expect, it } from "vitest";
import { actFromModel, classifyTurn, type ClassifiedTurn } from "./turn.mts";
import type { Session } from "./session.mts";

function sess(partial: Partial<Session>): Session {
  return {
    phone: "usr_test",
    chatId: "cnv_test",
    channel: "relay",
    step: "idle",
    shoppingCity: "New York",
    pending: null,
    updatedAt: Date.now(),
    ...partial,
  };
}

function act(s: Session, text: string, hasPhoto = false): ClassifiedTurn {
  return classifyTurn(s, { text, hasPhoto });
}

describe("classifyTurn — open question after a gap is never a search", () => {
  it("fuzzy date typo fills need_by (tomorow)", () => {
    const s = sess({
      step: "await_deadline",
      searchQuery: "PS5",
      selected: { productTitle: "PS5", storeName: "Target", priceCents: 49900 } as Session["selected"],
      pending: {
        slot: "need_by",
        proposed: "15th August",
        kind: "date",
        prompt: "Need it by 15th August?",
      },
    });
    const t = act(s, "tomorow");
    expect(t.act).toBe("CONTINUE");
    expect(t.slot).toBe("need_by");
    expect(t.value).toBeTruthy();
  });

  it("weekday typo teusday fills date", () => {
    const s = sess({
      step: "await_deadline",
      searchQuery: "charger",
      pending: { slot: "need_by", proposed: "Friday", kind: "date", prompt: "Need it by Friday?" },
    });
    expect(act(s, "teusday").act).toBe("CONTINUE");
  });

  it("single word binds to last listing option", () => {
    const s = sess({
      step: "await_listing",
      searchQuery: "hoodie",
      listings: [
        { storeName: "Target", productTitle: "Black hoodie", priceCents: 4000 },
        { storeName: "Walmart", productTitle: "Grey hoodie", priceCents: 2500 },
      ] as Session["listings"],
      pending: {
        slot: "listing",
        proposed: "0",
        kind: "choice",
        prompt: "Pick one",
        options: [
          { id: "0", label: "Target" },
          { id: "1", label: "Walmart" },
        ],
      },
    });
    const t = act(s, "black");
    expect(t.act).toBe("CONTINUE");
    expect(t.optionIndex).toBe(0);
  });

  it("the cheaper one binds to lowest-priced option", () => {
    const s = sess({
      step: "await_listing",
      searchQuery: "hoodie",
      listings: [
        { storeName: "Target", productTitle: "Hoodie A", priceCents: 4000 },
        { storeName: "Walmart", productTitle: "Hoodie B", priceCents: 2500 },
      ] as Session["listings"],
      pending: { slot: "listing", proposed: "0", kind: "choice", prompt: "Pick one" },
    });
    const t = act(s, "the cheaper one");
    expect(t.act).toBe("CONTINUE");
    expect(t.optionIndex).toBe(1);
  });

  it("bare hmm / that re-asks the open question", () => {
    const s = sess({
      step: "await_deadline",
      searchQuery: "PS5",
      pending: { slot: "need_by", proposed: "15th August", kind: "date", prompt: "Need it by 15th August?" },
    });
    expect(act(s, "hmm").act).toBe("REASK");
    expect(act(s, "that").act).toBe("REASK");
  });

  it("ok while a slot is open continues (apply proposed)", () => {
    const s = sess({
      step: "await_deadline",
      searchQuery: "PS5",
      pending: { slot: "need_by", proposed: "15th August", kind: "date", prompt: "Need it by 15th August?" },
    });
    expect(act(s, "ok").act).toBe("CONTINUE");
  });

  it("Amaa fuzzy-matches traveler option", () => {
    const s = sess({
      step: "await_traveler",
      searchQuery: "PS5",
      ranked: [{ id: "ama", name: "Ama", score: 1, departs: "Fri" }],
      pending: {
        slot: "traveler",
        proposed: "0",
        kind: "choice",
        prompt: "Pick a traveler",
        options: [{ id: "0", label: "Ama" }],
      },
    });
    const t = act(s, "Amaa");
    expect(t.act).toBe("CONTINUE");
    expect(t.optionIndex).toBe(0);
  });

  it("actually Friday repairs a filled date", () => {
    const s = sess({
      step: "await_max_fee",
      searchQuery: "PS5",
      deadline: new Date("2026-08-20"),
      pending: { slot: "delivery_fee", proposed: 3000, kind: "money", prompt: "Cap?" },
    });
    const t = act(s, "actually make it Friday");
    expect(t.act).toBe("REPAIR");
    expect(t.slot).toBe("need_by");
  });

  it("ambiguous fragment while requested_slot is set is REASK not NEW", () => {
    const s = sess({
      step: "await_deadline",
      searchQuery: "PS5",
      pending: { slot: "need_by", proposed: "15th August", kind: "date", prompt: "Need it by 15th August?" },
    });
    expect(act(s, "stuff").act).toBe("REASK");
    expect(act(s, "maybe").act).toBe("REASK");
  });

  it("unmistakable new item (photo or replacement product) is NEW", () => {
    const s = sess({
      step: "await_deadline",
      searchQuery: "PS5",
      pending: { slot: "need_by", proposed: "15th August", kind: "date", prompt: "Need it by 15th August?" },
    });
    expect(act(s, "actually get me a charger instead").act).toBe("NEW");
    expect(act(s, "", true).act).toBe("NEW");
    expect(act(s, "", true).act).toBe("NEW");
  });

  it("yes after an error retries CONTINUE, not NEW", () => {
    const s = sess({
      step: "await_listing",
      searchQuery: "PS5",
      pending: { slot: "listing", proposed: "0", kind: "choice", prompt: "Pick one" },
    });
    expect(act(s, "yes").act).toBe("CONTINUE");
  });

  it("cancel / status win over CONTINUE while a slot is open", () => {
    const s = sess({
      step: "await_deadline",
      searchQuery: "PS5",
      pending: { slot: "need_by", proposed: "15th August", kind: "date", prompt: "Need it by?" },
    });
    expect(act(s, "cancel").act).toBe("META");
    expect(act(s, "cancel").meta).toBe("cancel");
    expect(act(s, "status").act).toBe("META");
  });

  it("malformed model act falls back to REASK never NEW", () => {
    const s = sess({
      step: "await_deadline",
      pending: { slot: "need_by", proposed: "x", kind: "date", prompt: "Need it by?" },
    });
    expect(actFromModel(undefined, s)).toBe("REASK");
    expect(actFromModel({ nope: true }, s)).toBe("REASK");
    expect(actFromModel("SEARCH", s)).toBe("REASK");
  });

  it("recap title is not a new shop", () => {
    const s = sess({
      step: "await_traveler_decision",
      searchQuery: "Sony WH-1000XM5",
      selected: {
        productTitle: "Sony WH-1000XM5 Wireless Headphones",
        storeName: "Best Buy",
        priceCents: 32800,
      } as Session["selected"],
    });
    expect(act(s, "Sony WH-1000XM5 Wireless Headphones").act).not.toBe("NEW");
  });

  it("gap does not change classification (same utterance, same state)", () => {
    const s = sess({
      step: "await_deadline",
      searchQuery: "PS5",
      pending: { slot: "need_by", proposed: "15th August", kind: "date", prompt: "Need it by?" },
      updatedAt: Date.now() - 8 * 3600_000,
    });
    const now = act(s, "tomorow");
    const later = act({ ...s, updatedAt: Date.now() }, "tomorow");
    expect(now.act).toBe(later.act);
    expect(now.act).toBe("CONTINUE");
  });
});
