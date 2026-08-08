/**
 * Traveler job alerts: Accept / Decline.
 *
 * Accept → reserve the shopping request for this traveler, create a pending bid
 * (Traveler Accepted), notify the shopper. Shopper then pays (escrow fund).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { computeFees, suggestedTravelerFeeCents } from "@manebra/shared";
import { router, verifiedProcedure } from "../trpc.js";

export const matchesRouter = router({
  /** Job cards for the traveler (Step 5 view). */
  myJobs: verifiedProcedure.query(async ({ ctx }) => {
    const proposals = await ctx.prisma.matchProposal.findMany({
      where: { travelerId: ctx.user.id, status: "proposed" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const out = [];
    for (const p of proposals) {
      const item = await ctx.prisma.itemRequest.findUnique({ where: { id: p.itemRequestId } });
      const trip = await ctx.prisma.travelerTrip.findUnique({ where: { id: p.tripId } });
      if (!item || item.status !== "open" || item.reservedTravelerId) continue;
      const fee = suggestedTravelerFeeCents(item.itemCostCents);
      out.push({
        proposalId: p.id,
        score: p.score,
        product: {
          title: item.itemName,
          imageUrl: item.itemImageUrl,
          productUrl: item.itemUrl,
          retailer: item.retailerName,
          purchasePriceCents: item.itemCostCents,
          availability: item.availabilityLabel,
        },
        deliveryCity: item.destinationCity,
        shoppingCity: item.shoppingCity,
        requiredBy: item.expiresAt,
        deliveryFeeCents: fee,
        trip: trip
          ? { id: trip.id, departureDate: trip.departureDate, destinationCity: trip.destinationCity }
          : null,
      });
    }
    return out;
  }),

  /** Step 6 — traveler Accept: reserve request + create bid + notify shopper. */
  accept: verifiedProcedure
    .input(
      z.object({
        proposalId: z.string().uuid(),
        /** Optional override; default is server-suggested fee. */
        travelerFeeCents: z.number().int().min(1).max(1_000_00).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const proposal = await ctx.prisma.matchProposal.findUnique({ where: { id: input.proposalId } });
      if (!proposal || proposal.travelerId !== ctx.user.id || proposal.status !== "proposed") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Job alert not found." });
      }
      const item = await ctx.prisma.itemRequest.findUnique({ where: { id: proposal.itemRequestId } });
      if (!item || item.status !== "open") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Request is no longer open." });
      }
      if (item.reservedTravelerId) {
        throw new TRPCError({ code: "CONFLICT", message: "Another traveler already accepted this request." });
      }
      const trip = await ctx.prisma.travelerTrip.findUnique({ where: { id: proposal.tripId } });
      if (!trip || trip.travelerId !== ctx.user.id || trip.status !== "upcoming") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Trip is not available." });
      }

      const fee = input.travelerFeeCents ?? suggestedTravelerFeeCents(item.itemCostCents);
      const fees = computeFees(item.itemCostCents, fee);

      const bid = await ctx.prisma.bid.create({
        data: {
          itemRequestId: item.id,
          travelerId: ctx.user.id,
          tripId: trip.id,
          itemCostCentsSnapshot: item.itemCostCents,
          travelerFeeCents: fees.travelerFeeCents,
          commissionCents: fees.commissionCents,
          totalCents: fees.totalCents,
          promisedDeliveryDate: item.expiresAt,
          status: "pending",
          expiresAt: new Date(Date.now() + 72 * 3600_000),
        },
      });

      await ctx.prisma.itemRequest.update({
        where: { id: item.id },
        data: { reservedTravelerId: ctx.user.id, reservedBidId: bid.id },
      });
      await ctx.prisma.matchProposal.update({
        where: { id: proposal.id },
        data: { status: "converted" },
      });
      // Dismiss other open proposals for this item
      await ctx.prisma.matchProposal.updateMany({
        where: { itemRequestId: item.id, status: "proposed", id: { not: proposal.id } },
        data: { status: "dismissed" },
      });

      await ctx.prisma.notification.create({
        data: {
          userId: item.shopperId,
          kind: "match_proposed",
          title: "Traveler accepted your request",
          body:
            `${ctx.user.fullName ?? "A traveler"} accepted "${item.itemName}" for delivery to ${item.destinationCity}. ` +
            `Pay ${formatUsd(fees.totalCents)} (item + delivery + platform fee) to confirm.`,
          data: {
            itemRequestId: item.id,
            bidId: bid.id,
            travelerId: ctx.user.id,
            totalCents: fees.totalCents,
          },
          status: "pending",
        },
      });

      return {
        bidId: bid.id,
        requestId: item.id,
        uiStatus: "traveler_accepted" as const,
        totalCents: fees.totalCents,
        travelerFeeCents: fees.travelerFeeCents,
        commissionCents: fees.commissionCents,
        note: "Request reserved. Shopper has been notified to pay into escrow.",
      };
    }),

  /** Traveler Decline. */
  decline: verifiedProcedure
    .input(z.object({ proposalId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const proposal = await ctx.prisma.matchProposal.findUnique({ where: { id: input.proposalId } });
      if (!proposal || proposal.travelerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return ctx.prisma.matchProposal.update({
        where: { id: proposal.id },
        data: { status: "dismissed" },
      });
    }),
});

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
