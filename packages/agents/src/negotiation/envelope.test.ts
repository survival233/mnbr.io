import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildEnvelopePayload, verifyEnvelope, type Envelope, type SignedEnvelope } from "./envelope";

const CHAIN_ID = 84532;
const e: Envelope = { role: "shopper", itemRequestId: "item-1", tripId: "trip-1", limitFeeCents: 3000, validUntil: 1_900_000_000 };

describe("signed envelopes", () => {
  it("sign → verify roundtrip with an agent wallet", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const signature = await acct.signTypedData(buildEnvelopePayload(CHAIN_ID, e));
    const se: SignedEnvelope = { ...e, signer: acct.address, signature };
    expect(await verifyEnvelope(CHAIN_ID, se)).toBe(true);
  });
  it("tampered limit fails verification", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const signature = await acct.signTypedData(buildEnvelopePayload(CHAIN_ID, e));
    const tampered: SignedEnvelope = { ...e, limitFeeCents: 999_999, signer: acct.address, signature };
    expect(await verifyEnvelope(CHAIN_ID, tampered)).toBe(false);
  });
  it("signature from a different wallet fails", async () => {
    const a = privateKeyToAccount(generatePrivateKey());
    const b = privateKeyToAccount(generatePrivateKey());
    const signature = await a.signTypedData(buildEnvelopePayload(CHAIN_ID, e));
    expect(await verifyEnvelope(CHAIN_ID, { ...e, signer: b.address, signature })).toBe(false);
  });
  it("wrong chain id fails", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const signature = await acct.signTypedData(buildEnvelopePayload(CHAIN_ID, e));
    expect(await verifyEnvelope(1, { ...e, signer: acct.address, signature })).toBe(false);
  });
});
