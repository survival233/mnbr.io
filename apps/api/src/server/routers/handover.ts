/**
 * Handover router — PRD §10.2, MERGED with escrow settlement.
 * Shopper-held 6-digit code; traveler entry triggers the `arrived → delivered`
 * system transition.
 *
 * [MERGE — touchpoint B] The Stripe payout call is replaced by
 * scheduleEscrowRelease: escrow settlement is FINAL (no chargeback), so the
 * release fires AFTER the 48h dispute window via Inngest, and only if no
 * dispute moved the bid off `delivered`. Everything above the swap is the
 * original flow: HMAC verification, attempt lockout, state machine.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  generateHandoverCode,
  hashHandoverCode,
  verifyHandoverCode,
  HANDOVER_CODE_TTL_MS,
  HANDOVER_MAX_ATTEMPTS,
  assertTransition,
  type BidStatus,
} from "@manebra/shared";
import { scheduleEscrowRelease } from "@manebra/settlement/server";
import { router, verifiedProcedure } from "../trpc.js";

function secret(): string {
  const s = process.env.HANDOVER_CODE_SECRET;
  if (!s) throw new Error("HANDOVER_CODE_SECRET is not set");
  return s;
}

export const handoverRouter = router({
  /**
   * SHOPPER requests the code once the bid is `arrived`. Plaintext is returned
   * exactly once per generation; only the HMAC is stored.
   */
  generateCode: verifiedProcedure
    .input(z.object({ bidId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const bid = await ctx.prisma.bid.findUnique({
        where: { id: input.bidId },
        include: { itemRequest: true },
      });
      if (!bid || bid.itemRequest.shopperId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (bid.status !== "arrived") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Handover codes are available once the traveler has arrived.",
        });
      }

      const code = generateHandoverCode();
      const codeHash = hashHandoverCode(code, bid.id, secret());

      await ctx.prisma.$transaction([
        // Regeneration invalidates any previous active code (PRD §10.2).
        ctx.prisma.handoverCode.updateMany({
          where: { bidId: bid.id, active: true },
          data: { active: false },
        }),
        ctx.prisma.handoverCode.create({
          data: {
            bidId: bid.id,
            codeHash,
            expiresAt: new Date(Date.now() + HANDOVER_CODE_TTL_MS),
          },
        }),
      ]);

      return { code }; // shown in shopper UI; never logged, never stored
    }),

  /**
   * TRAVELER enters the code the shopper gave them after inspecting the item.
   * On success: arrived → delivered; escrow release SCHEDULED for after the
   * 48h dispute window (no immediate payout — settlement is final).
   */
  confirmCode: verifiedProcedure
    .input(z.object({ bidId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const bid = await ctx.prisma.bid.findUnique({
        where: { id: input.bidId },
        include: { traveler: true },
      });
      if (!bid || bid.travelerId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND" });
      assertTransition(bid.status as BidStatus, "delivered", "system");

      const record = await ctx.prisma.handoverCode.findFirst({
        where: { bidId: bid.id, active: true },
      });
      if (!record || record.expiresAt < new Date()) {
        throw new TRPCError({ code: "CONFLICT", message: "No active handover code. Ask the shopper to regenerate." });
      }
      if (record.attempts >= HANDOVER_MAX_ATTEMPTS) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many attempts. Contact support to complete this handover.",
        });
      }

      const valid = verifyHandoverCode(input.code, bid.id, record.codeHash, secret());
      if (!valid) {
        await ctx.prisma.handoverCode.update({
          where: { id: record.id },
          data: { attempts: { increment: 1 } },
        });
        throw new TRPCError({ code: "BAD_REQUEST", message: "Incorrect code." });
      }

      // Finalize state; [MERGE] the payout call is now the escrow scheduler.
      await ctx.prisma.$transaction([
        ctx.prisma.handoverCode.update({
          where: { id: record.id },
          data: { active: false, confirmedAt: new Date() },
        }),
        ctx.prisma.bid.update({
          where: { id: bid.id },
          data: { status: "delivered", deliveredAt: new Date() },
        }),
      ]);

      // [MERGE — touchpoint B] was: await releaseTravelerPayout(bid) + ledger write.
      // Escrow releases after the 48h dispute window (Inngest sleepUntil), and
      // onReleaseScheduled writes the escrow ledger rows itself.
      await scheduleEscrowRelease(bid.id);

      return { status: "delivered" as const };
    }),
});
