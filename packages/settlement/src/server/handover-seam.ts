/**
 * THE SEAM — corrected to the real mnbr/manebra shapes.
 *
 * Your handover router (apps/api/src/server/routers/handover.ts) ALREADY:
 *   - verifies the 6-digit code (HMAC, constant-time, attempt lockout)
 *   - runs the `arrived → delivered` transition via assertTransition
 *   - then calls releaseTravelerPayout (Stripe)
 *
 * This module replaces ONLY that last call. Escrow settlement is final (no
 * chargeback), so instead of paying out immediately we schedule the release
 * for after the 48h dispute window (PRD §: disputes open within 48h of
 * delivery), and the Inngest handler releases only if no dispute opened.
 *
 * In the handover router, change:
 *     await releaseTravelerPayout(bid);            // Stripe path
 * to:
 *     await scheduleEscrowRelease(bid.id);         // escrow path
 *
 * Ledger: every on-chain movement is recorded in payout_ledger (records,
 * never balances — same posture as the Stripe path).
 */
import { prisma } from "@manebra/db";
import { assertTransition, type BidStatus } from "@manebra/shared";
import { bidIdToEscrowId } from "../core/escrow-id";
import { signRelease, signRefund, attestorClient } from "./attestor";
import { settlementConfig } from "./config";
import { HandoverEscrowAbi } from "../core/abi";

/** Wire to the real Inngest client in apps/api (same pattern as existing jobs). */
import { inngest } from "./events";

const DISPUTE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Called from the handover router immediately after the `arrived → delivered`
 * transition commits (code already verified by the router — do NOT re-verify here).
 * Moves no money; opens the dispute window.
 */
export async function scheduleEscrowRelease(bidId: string): Promise<void> {
  await inngest.send({
    name: "settlement/escrow.release.scheduled",
    data: { bidId, notBefore: Date.now() + DISPUTE_WINDOW_MS },
  });
}

/**
 * Inngest handler, fires after the dispute window. Releases only if the bid is
 * still `delivered` (a dispute would have moved it to `disputed`).
 */
export async function onReleaseScheduled(bidId: string): Promise<void> {
  const bid = await prisma.bid.findUniqueOrThrow({ where: { id: bidId } });
  if (bid.status !== "delivered") return; // disputed/refunded — resolver drives the outcome
  if (bid.escrowState !== "funded") return; // already settled or never escrow-funded

  const escrowId = bidIdToEscrowId(bidId);
  const { deadline, signature } = await signRelease(escrowId);
  const txHash = await attestorClient.writeContract({
    address: settlementConfig.escrowAddress,
    abi: HandoverEscrowAbi,
    functionName: "release",
    args: [escrowId, deadline, signature],
  });

  await prisma.$transaction([
    prisma.bid.update({
      where: { id: bidId },
      data: { escrowState: "released", escrowSettleTxHash: txHash },
    }),
    // subtotal → traveler
    prisma.payoutLedger.create({
      data: {
        bidId,
        type: "escrow_release",
        amountCents: bid.itemCostCentsSnapshot + bid.travelerFeeCents,
        currency: bid.currency,
        onchainTxHash: txHash,
        status: "succeeded",
      },
    }),
    // commission → treasury (same tx on-chain; separate ledger record, like application_fee)
    prisma.payoutLedger.create({
      data: {
        bidId,
        type: "escrow_release",
        amountCents: bid.commissionCents,
        currency: bid.currency,
        onchainTxHash: txHash,
        status: "succeeded",
        metadata: { leg: "commission" },
      },
    }),
  ]);
}

/**
 * Dispute resolution → refund (admin console). The bid is `disputed`; the admin
 * resolution maps it to `refunded`. Full total returns to the shopper; Manebra
 * forgoes commission (contract enforces this).
 */
export async function refundEscrowForBid(bidId: string): Promise<void> {
  const bid = await prisma.bid.findUniqueOrThrow({ where: { id: bidId } });
  assertTransition(bid.status as BidStatus, "refunded", "admin"); // throws → surface as 409
  if (bid.escrowState !== "funded") {
    throw new Error(`escrow for bid ${bidId} is ${bid.escrowState}, not funded`);
  }

  const escrowId = bidIdToEscrowId(bidId);
  const { deadline, signature } = await signRefund(escrowId);
  const txHash = await attestorClient.writeContract({
    address: settlementConfig.escrowAddress,
    abi: HandoverEscrowAbi,
    functionName: "refund",
    args: [escrowId, deadline, signature],
  });

  await prisma.$transaction([
    prisma.bid.update({
      where: { id: bidId },
      data: { status: "refunded", refundedAt: new Date(), escrowState: "refunded", escrowSettleTxHash: txHash },
    }),
    prisma.payoutLedger.create({
      data: {
        bidId,
        type: "escrow_refund",
        amountCents: bid.totalCents,
        currency: bid.currency,
        onchainTxHash: txHash,
        status: "succeeded",
      },
    }),
  ]);
}
