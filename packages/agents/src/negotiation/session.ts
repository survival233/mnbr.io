/**
 * Negotiation session — thin server orchestration around the pure engine.
 * ADVISORY BY DEFAULT: a deal emits `agents/negotiation.agreed`; converting it
 * into a real bid goes through the normal bids.create flow (kernel re-checks
 * everything — fees are recomputed server-side from the agreed travelerFee).
 *
 * Both envelopes must verify against the principals' agent-wallet addresses
 * before a session starts; expiry and bounds live inside the engine.
 */
import { prisma } from "@manebra/db";
import { verifyEnvelope, type SignedEnvelope } from "./envelope";
import { runNegotiation, DEFAULT_ENGINE_CONFIG, type NegotiationOutcome } from "./engine";

import { inngest } from "../events";

export class EnvelopeVerificationError extends Error {}

export async function startNegotiation(args: {
  chainId: number;
  shopperEnvelope: SignedEnvelope;
  travelerEnvelope: SignedEnvelope;
  shopperId: string;
  travelerId: string;
}): Promise<NegotiationOutcome> {
  const { chainId, shopperEnvelope: s, travelerEnvelope: t } = args;

  if (s.role !== "shopper" || t.role !== "traveler") throw new EnvelopeVerificationError("role mismatch");
  if (s.itemRequestId !== t.itemRequestId) throw new EnvelopeVerificationError("envelopes reference different items");
  if (!(await verifyEnvelope(chainId, s))) throw new EnvelopeVerificationError("shopper envelope signature invalid");
  if (!(await verifyEnvelope(chainId, t))) throw new EnvelopeVerificationError("traveler envelope signature invalid");

  const result = runNegotiation(s, t, DEFAULT_ENGINE_CONFIG);

  await prisma.negotiationSession.create({
    data: {
      itemRequestId: s.itemRequestId,
      tripId: t.tripId,
      shopperId: args.shopperId,
      travelerId: args.travelerId,
      status: result.outcome === "deal" ? "deal" : "no_deal",
      agreedFeeCents: result.outcome === "deal" ? result.feeCents : null,
      transcript: result.transcript as object,
    },
  });

  if (result.outcome === "deal") {
    await inngest.send({
      name: "agents/negotiation.agreed",
      data: {
        itemRequestId: s.itemRequestId,
        tripId: t.tripId,
        travelerId: args.travelerId,
        agreedTravelerFeeCents: result.feeCents,
        // conversion path: traveler confirms → bids.create with this fee;
        // the kernel recomputes commission/total and re-runs every gate.
      },
    });
  }
  return result;
}
