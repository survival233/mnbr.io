import { describe, expect, it } from "vitest";
import { reconcileOrderTotal, orderFromEvent, handleConfirmedOrder } from "./vector-c";

describe("reconcileOrderTotal", () => {
  it("matches an exact total", () => {
    expect(reconcileOrderTotal(5000, 5000)).toEqual({ status: "match", deltaCents: 0, ok: true });
  });

  it("treats a cheaper order as under and ok (refund the difference)", () => {
    const v = reconcileOrderTotal(5000, 4200);
    expect(v).toEqual({ status: "under", deltaCents: -800, ok: true });
  });

  it("flags any overage when tolerance is zero", () => {
    const v = reconcileOrderTotal(5000, 5001);
    expect(v.status).toBe("over_tolerance");
    expect(v.ok).toBe(false);
  });

  it("absorbs an overage within tolerance (tax/shipping drift)", () => {
    // 2% of 5000 = 100 cents allowed above held.
    expect(reconcileOrderTotal(5000, 5100, 200).status).toBe("match");
    expect(reconcileOrderTotal(5000, 5101, 200).status).toBe("over_tolerance");
  });

  it("rejects nonsense inputs", () => {
    expect(() => reconcileOrderTotal(-1, 100)).toThrow();
    expect(() => reconcileOrderTotal(100, Number.NaN)).toThrow();
  });
});

describe("orderFromEvent", () => {
  it("reads a nested order", () => {
    const o = orderFromEvent({ order: { order_id: "o1", merchant: "amazon", total_cents: 1799, status: "confirmed" } });
    expect(o).toEqual({ orderId: "o1", merchant: "amazon", totalCents: 1799, status: "confirmed" });
  });

  it("reads an inlined order", () => {
    const o = orderFromEvent({ order_id: "o2", merchant: "target", total_cents: 999, status: "placed" });
    expect(o?.totalCents).toBe(999);
  });

  it("returns null when no total is present yet", () => {
    expect(orderFromEvent({ order_id: "o3", status: "placing" })).toBeNull();
  });
});

describe("handleConfirmedOrder", () => {
  it("routes a clean reconcile to onReconciled", async () => {
    const calls: string[] = [];
    const verdict = await handleConfirmedOrder(
      "trip-1",
      { order: { order_id: "o1", merchant: "amazon", total_cents: 5000, status: "confirmed" } },
      {
        heldAmountCents: async () => 5000,
        onReconciled: async () => { calls.push("reconciled"); },
        onOverage: async () => { calls.push("overage"); },
      },
    );
    expect(verdict?.ok).toBe(true);
    expect(calls).toEqual(["reconciled"]);
  });

  it("routes an over-tolerance order to onOverage and never releases", async () => {
    const calls: string[] = [];
    const verdict = await handleConfirmedOrder(
      "trip-2",
      { order: { order_id: "o2", merchant: "amazon", total_cents: 9000, status: "confirmed" } },
      {
        heldAmountCents: async () => 5000,
        onReconciled: async () => { calls.push("reconciled"); },
        onOverage: async () => { calls.push("overage"); },
      },
    );
    expect(verdict?.ok).toBe(false);
    expect(calls).toEqual(["overage"]);
  });
});
