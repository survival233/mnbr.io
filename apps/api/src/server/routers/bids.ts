/**
 * Bids router — PRD §6, §7, §10, §12, MERGED with escrow settlement.
 *
 * Server-side money rule unchanged: clients send ONLY travelerFeeCents;
 * commission and total are computed here via @manebra/shared.
 *
 * [MERGE — touchpoint A] `accept` no longer creates a Stripe PaymentIntent.
 * It provisions agent wallets, computes the escrow terms from the SAME
 * computeFees output stored on the bid, and calls escrow.open() on-chain.
 * Funding happens in settlement.fundBid (gasless EIP-3009).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  computeFees,
  assertTransition,
  IllegalTransitionError,
  NEW_USER_ITEM_CAP_CENTS,
  NEW_USER_MAX_CONCURRENT,
  NEW_USER_DELIVERY_THRESHOLD,
  HIGH_VALUE_ITEM_CENTS,
  HIGH_VALUE_MIN_TRUST,
  type BidStatus,
} from "@manebra/shared";
import { bidIdToEscrowId, centsToUsdc } from "@manebra/settlement";
import { operatorClient, settlementConfig } from "@manebra/settlement/server";
import { HandoverEscrowAbi } from "@manebra/settlement/abi";
import { router, verifiedProcedure } from "../trpc.js";
import { getWalletProvider } from "../wallets.js";

const ACTIVE_BID_STATUSES: BidStatus[] = ["funded", "purchased", "in_transit", "arrived"];
const ESCROW_RECLAIM_WINDOW_S = 14 * 24 * 3600; // shopper can reclaim if flow stalls

export const bidsRouter = router({
  /** Traveler places a bid on an open item request. (Original gates, unchanged.) */
  create: verifiedProcedure
    .input(
      z.object({
        itemRequestId: z.string().uuid(),
        tripId: z.string().uuid(),
        travelerFeeCents: z.number().int().min(1).max(1_000_00),
        promisedDeliveryDate: z.coerce.date(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.prisma.itemRequest.findUnique({ where: { id: input.itemRequestId } });
      if (!item || item.status !== "open" || item.reviewStatus === "rejected") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Item is not open for bidding." });
      }
      if (item.shopperId === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot bid on your own item." });
      }
      const trip = await ctx.prisma.travelerTrip.findUnique({ where: { id: input.tripId } });
      if (!trip || trip.travelerId !== ctx.user.id || trip.status !== "upcoming") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Bid must attach to your own upcoming trip." });
      }
      if (trip.direction !== item.direction) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Trip direction does not match the item." });
      }

      // New-user + high-value gates (PRD §12.2)
      const isNew = ctx.user.totalDeliveries < NEW_USER_DELIVERY_THRESHOLD;
      if (isNew && item.itemCostCents > NEW_USER_ITEM_CAP_CENTS) {
        throw new TRPCError({ code: "FORBIDDEN", message: "New travelers cannot take items above the cap." });
      }
      if (isNew) {
        const active = await ctx.prisma.bid.count({
          where: { travelerId: ctx.user.id, status: { in: ACTIVE_BID_STATUSES } },
        });
        if (active >= NEW_USER_MAX_CONCURRENT) {
          throw new TRPCError({ code: "FORBIDDEN", message: "New travelers are limited to two concurrent deliveries." });
        }
      }
      if (item.itemCostCents > HIGH_VALUE_ITEM_CENTS && ctx.user.trustScore < HIGH_VALUE_MIN_TRUST) {
        throw new TRPCError({ code: "FORBIDDEN", message: "High-value items require a higher trust score." });
      }

      const fees = computeFees(item.itemCostCents, input.travelerFeeCents);
      return ctx.prisma.bid.create({
        data: {
          itemRequestId: item.id,
          travelerId: ctx.user.id,
          tripId: trip.id,
          itemCostCentsSnapshot: fees.itemCostCents,
          travelerFeeCents: fees.travelerFeeCents,
          commissionCents: fees.commissionCents,
          totalCents: fees.totalCents,
          currency: fees.currency,
          promisedDeliveryDate: input.promisedDeliveryDate,
          expiresAt: new Date(Date.now() + 72 * 3600 * 1000), // pending only
        },
      });
    }),

  /**
   * SHOPPER accepts a bid.
   * [MERGE] was: create Stripe PaymentIntent (client secret never persisted).
   * now: provision agent wallets → open the on-chain escrow with the bid's
   * server-computed amounts → mirror `escrowState: opened`.
   */
  accept: verifiedProcedure
    .input(z.object({ bidId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const bid = await ctx.prisma.bid.findUnique({
        where: { id: input.bidId },
        include: { itemRequest: true },
      });
      if (!bid || bid.itemRequest.shopperId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND" });

      try {
        assertTransition(bid.status as BidStatus, "accepted", "shopper");
      } catch (e) {
        if (e instanceof IllegalTransitionError) throw new TRPCError({ code: "CONFLICT", message: e.message });
        throw e;
      }

      // Agent wallets for both principals (deterministic per user+role; keys
      // never leave the provider). Persist addresses on first use.
      const provider = getWalletProvider();
      const shopperW = await provider.getOrCreateWallet(ctx.user.id, "shopper_agent");
      const travelerW = await provider.getOrCreateWallet(bid.travelerId, "traveler_agent");
      await ctx.prisma.user.update({ where: { id: ctx.user.id }, data: { walletAddress: shopperW.address } }).catch(() => {});
      await ctx.prisma.user.update({ where: { id: bid.travelerId }, data: { walletAddress: travelerW.address } }).catch(() => {});

      // Open escrow with SERVER-COMPUTED terms frozen on the bid (computeFees output).
      const escrowId = bidIdToEscrowId(bid.id);
      // open() is onlyOperator — must not use the attestor key when roles differ (Sepolia).
      const txHash = await operatorClient.writeContract({
        address: settlementConfig.escrowAddress,
        abi: HandoverEscrowAbi,
        functionName: "open",
        args: [
          escrowId,
          shopperW.address,
          travelerW.address,
          centsToUsdc(bid.itemCostCentsSnapshot + bid.travelerFeeCents), // subtotal → traveler
          centsToUsdc(bid.commissionCents), // commission → treasury
          BigInt(Math.floor(Date.now() / 1000) + ESCROW_RECLAIM_WINDOW_S),
        ],
      });

      await ctx.prisma.$transaction([
        ctx.prisma.bid.update({
          where: { id: bid.id },
          data: { status: "accepted", escrowId, escrowState: "opened" },
        }),
        ctx.prisma.payoutLedger.create({
          data: {
            bidId: bid.id,
            type: "escrow_open",
            amountCents: bid.totalCents,
            currency: bid.currency,
            onchainTxHash: txHash,
            status: "succeeded",
          },
        }),
      ]);

      return { status: "accepted" as const, escrowId };
    }),
});
