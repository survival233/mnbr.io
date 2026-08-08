import { describe, it, expect } from "vitest";
import { bidIdToEscrowId } from "./escrow-id";
import { keccak256, stringToBytes } from "viem";

describe("bidIdToEscrowId", () => {
  it("is a 32-byte hex value", () => {
    const id = bidIdToEscrowId("bid_abc123");
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic (same bid → same escrow id)", () => {
    expect(bidIdToEscrowId("bid_abc123")).toBe(bidIdToEscrowId("bid_abc123"));
  });

  it("is collision-resistant across distinct ids", () => {
    expect(bidIdToEscrowId("bid_a")).not.toBe(bidIdToEscrowId("bid_b"));
  });

  it("matches keccak256(utf8) so the contract and backend agree", () => {
    const bidId = "clx9f2k0000008l3g1abcd42";
    expect(bidIdToEscrowId(bidId)).toBe(keccak256(stringToBytes(bidId)));
  });

  it("rejects an empty bid id", () => {
    expect(() => bidIdToEscrowId("")).toThrow();
  });
});
