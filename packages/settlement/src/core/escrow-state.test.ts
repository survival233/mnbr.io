import { describe, it, expect } from "vitest";
import {
  classifyDrift,
  onChainToMirror,
  OnChainEscrowState,
  type MirrorEscrowState,
} from "./escrow-state";

const ALL: MirrorEscrowState[] = ["none", "opened", "funded", "released", "refunded"];

describe("onChainToMirror", () => {
  it("maps every on-chain enum value", () => {
    expect(onChainToMirror(OnChainEscrowState.None)).toBe("none");
    expect(onChainToMirror(OnChainEscrowState.Opened)).toBe("opened");
    expect(onChainToMirror(OnChainEscrowState.Funded)).toBe("funded");
    expect(onChainToMirror(OnChainEscrowState.Released)).toBe("released");
    expect(onChainToMirror(OnChainEscrowState.Refunded)).toBe("refunded");
  });
  it("throws on an unknown value", () => {
    expect(() => onChainToMirror(9 as OnChainEscrowState)).toThrow();
  });
});

describe("classifyDrift — exhaustive 5×5 matrix", () => {
  // expected verdict kind for [mirror][chain]
  const expected: Record<MirrorEscrowState, Record<MirrorEscrowState, string>> = {
    none:     { none: "in_sync", opened: "heal",    funded: "heal",    released: "heal",     refunded: "heal" },
    opened:   { none: "anomaly", opened: "in_sync", funded: "heal",    released: "heal",     refunded: "heal" },
    funded:   { none: "anomaly", opened: "anomaly", funded: "in_sync", released: "heal",     refunded: "heal" },
    released: { none: "anomaly", opened: "anomaly", funded: "anomaly", released: "in_sync",  refunded: "anomaly" },
    refunded: { none: "anomaly", opened: "anomaly", funded: "anomaly", released: "anomaly",  refunded: "in_sync" },
  };

  for (const mirror of ALL) {
    for (const chain of ALL) {
      it(`mirror=${mirror} chain=${chain} → ${expected[mirror][chain]}`, () => {
        expect(classifyDrift(mirror, chain).kind).toBe(expected[mirror][chain]);
      });
    }
  }
});

describe("classifyDrift — verdict details", () => {
  it("heal reports from/to", () => {
    const v = classifyDrift("funded", "released");
    expect(v).toEqual({ kind: "heal", from: "funded", to: "released" });
  });
  it("terminal conflict is its own reason", () => {
    const v = classifyDrift("released", "refunded");
    expect(v).toMatchObject({ kind: "anomaly", reason: "terminal_conflict" });
  });
  it("mirror leading the chain is flagged", () => {
    const v = classifyDrift("funded", "opened");
    expect(v).toMatchObject({ kind: "anomaly", reason: "mirror_ahead_of_chain" });
  });
});
