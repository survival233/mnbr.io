/**
 * Disputes (admin resolution slice) — [MERGE — touchpoint C]
 * resolve-as-refund now settles via the escrow refund attestation.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { refundEscrowForBid } from "@manebra/settlement/server";
import { router, verifiedProcedure } from "../trpc.js";

export const disputesRouter = router({
  /** ADMIN resolves a dispute as refund: full total back to shopper on-chain. */
  resolveRefund: verifiedProcedure // swap for your admin-gated procedure
    .input(z.object({ bidId: z.string().uuid(), disputeId: z.string().uuid(), notes: z.string().max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const dispute = await ctx.prisma.dispute.findUnique({ where: { id: input.disputeId } });
      if (!dispute || dispute.bidId !== input.bidId || dispute.status !== "open") {
        throw new TRPCError({ code: "CONFLICT", message: "Dispute is not open." });
      }
      // asserts <status> → refunded as "admin", moves USDC, writes ledger + bid mirror
      await refundEscrowForBid(input.bidId);
      await ctx.prisma.dispute.update({
        where: { id: dispute.id },
        data: { status: "resolved_refund", resolutionNotes: input.notes, resolvedAt: new Date() },
      });
      return { resolved: "refund" as const };
    }),
});
