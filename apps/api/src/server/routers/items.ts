/**
 * Shopper shopping flow.
 *
 * Live path: items.search (Google Shopping → verified stores) → createFromListing
 * Manual path: createManual when the shopper already has a store link/price
 * Neither uses Apple/Best Buy/Walmart developer APIs nor dummy catalog prices.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { findListing, searchProducts, supportedShoppingCities } from "@manebra/catalog";
import { normalizeCity } from "@manebra/calendar";
import { proposeMatchesForItem } from "@manebra/agents/matching";
import { shoppingRequestUiStatus, suggestedTravelerFeeCents, computeFees, endOfLocalDay } from "@manebra/shared";
import { router, verifiedProcedure, publicProcedure } from "../trpc.js";

const categorySchema = z.enum([
  "electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable",
]);

async function createRequestAndNotify(
  prisma: typeof import("@manebra/db").prisma,
  shopperId: string,
  data: {
    itemName: string;
    itemCostCents: number;
    itemUrl?: string | null;
    itemImageUrl?: string | null;
    category: z.infer<typeof categorySchema>;
    destinationCity: string;
    shoppingCity: string;
    retailerName: string;
    retailerListingId?: string | null;
    quantity: number;
    notes?: string | null;
    availabilityLabel?: string | null;
    neededBy: Date;
  },
) {
  const item = await prisma.itemRequest.create({
    data: {
      shopperId,
      itemName: data.itemName,
      itemCostCents: data.itemCostCents,
      itemUrl: data.itemUrl ?? undefined,
      itemImageUrl: data.itemImageUrl ?? undefined,
      category: data.category,
      direction: "us_to_gh",
      destinationCity: data.destinationCity,
      shoppingCity: data.shoppingCity,
      retailerName: data.retailerName,
      retailerListingId: data.retailerListingId ?? undefined,
      quantity: data.quantity,
      notes: data.notes ?? undefined,
      availabilityLabel: data.availabilityLabel ?? undefined,
      reviewStatus: "auto_approved",
      status: "open",
      expiresAt: endOfLocalDay(data.neededBy),
    },
  });

  const alerts = await proposeMatchesForItem(item.id);
  const suggestedFee = suggestedTravelerFeeCents(data.itemCostCents);
  const preview = computeFees(data.itemCostCents, suggestedFee);

  return {
    requestId: item.id,
    uiStatus: shoppingRequestUiStatus({
      itemStatus: item.status,
      reservedTravelerId: item.reservedTravelerId,
    }),
    product: {
      title: item.itemName,
      retailer: item.retailerName,
      priceCents: item.itemCostCents,
      productUrl: item.itemUrl,
      imageUrl: item.itemImageUrl,
      availability: item.availabilityLabel,
      shoppingCity: item.shoppingCity,
    },
    delivery: {
      destinationCity: item.destinationCity,
      neededBy: item.expiresAt,
      quantity: item.quantity,
      notes: item.notes,
    },
    travelersNotified: alerts,
    feePreview: {
      suggestedTravelerFeeCents: suggestedFee,
      commissionCents: preview.commissionCents,
      totalCents: preview.totalCents,
    },
  };
}

export const itemsRouter = router({
  shoppingCities: publicProcedure.query(() => supportedShoppingCities()),

  /**
   * Live search across verified stores (Apple, Best Buy, Walmart, …) via Google Shopping.
   * One aggregator key — not each store's API. No dummy catalog.
   */
  search: verifiedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(200),
        shoppingCity: z.string().min(1).max(100).default("New York"),
      }),
    )
    .query(async ({ input }) => {
      const city = normalizeCity(input.shoppingCity) ?? input.shoppingCity;
      return searchProducts({ query: input.query, shoppingCity: city });
    }),

  /** Create from a listing returned by a recent live items.search. */
  createFromListing: verifiedProcedure
    .input(
      z.object({
        listingId: z.string().min(1),
        shoppingCity: z.string().min(1).max(100),
        destinationCity: z.string().min(1).max(100),
        neededBy: z.coerce.date(),
        quantity: z.number().int().min(1).max(10).default(1),
        notes: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.userRole === "traveler") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only shoppers can create shopping requests." });
      }
      const shoppingCity = normalizeCity(input.shoppingCity) ?? input.shoppingCity;
      const destinationCity = normalizeCity(input.destinationCity) ?? input.destinationCity;
      const listing = findListing(input.listingId, shoppingCity);
      if (!listing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Listing expired or unknown — run items.search again and reselect.",
        });
      }
      if (input.neededBy.getTime() <= Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Delivery date must be in the future." });
      }
      return createRequestAndNotify(ctx.prisma, ctx.user.id, {
        itemName: listing.productTitle,
        itemCostCents: listing.priceCents * input.quantity,
        itemUrl: listing.productUrl,
        itemImageUrl: listing.imageUrl,
        category: listing.category,
        destinationCity,
        shoppingCity,
        retailerName: listing.storeName,
        retailerListingId: listing.listingId,
        quantity: input.quantity,
        notes: input.notes,
        availabilityLabel: listing.availabilityLabel,
        neededBy: input.neededBy,
      });
    }),

  /**
   * Manual path — shopper already has store / title / price / URL.
   * Use when they paste a link instead of searching.
   */
  createManual: verifiedProcedure
    .input(
      z.object({
        itemName: z.string().min(1).max(255),
        retailerName: z.string().min(1).max(100),
        priceUsd: z.number().positive().max(50_000),
        productUrl: z.string().url().optional(),
        imageUrl: z.string().url().optional(),
        category: categorySchema.default("electronics"),
        shoppingCity: z.string().min(1).max(100).default("New York"),
        destinationCity: z.string().min(1).max(100),
        neededBy: z.coerce.date(),
        quantity: z.number().int().min(1).max(10).default(1),
        notes: z.string().max(2000).optional(),
        availabilityLabel: z.string().max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.userRole === "traveler") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only shoppers can create shopping requests." });
      }
      if (input.neededBy.getTime() <= Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Delivery date must be in the future." });
      }
      const shoppingCity = normalizeCity(input.shoppingCity) ?? input.shoppingCity;
      const destinationCity = normalizeCity(input.destinationCity) ?? input.destinationCity;
      return createRequestAndNotify(ctx.prisma, ctx.user.id, {
        itemName: input.itemName,
        itemCostCents: Math.round(input.priceUsd * 100) * input.quantity,
        itemUrl: input.productUrl,
        itemImageUrl: input.imageUrl,
        category: input.category,
        destinationCity,
        shoppingCity,
        retailerName: input.retailerName,
        quantity: input.quantity,
        notes: input.notes,
        availabilityLabel: input.availabilityLabel ?? "Shopper-provided",
        neededBy: input.neededBy,
      });
    }),

  get: verifiedProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const item = await ctx.prisma.itemRequest.findUnique({ where: { id: input.requestId } });
      if (!item) throw new TRPCError({ code: "NOT_FOUND" });
      const bid = item.reservedBidId
        ? await ctx.prisma.bid.findUnique({ where: { id: item.reservedBidId } })
        : null;
      return {
        ...item,
        uiStatus: shoppingRequestUiStatus({
          itemStatus: item.status,
          reservedTravelerId: item.reservedTravelerId,
          bidStatus: bid?.status,
        }),
        bid,
      };
    }),

  mine: verifiedProcedure.query(async ({ ctx }) => {
    const items = await ctx.prisma.itemRequest.findMany({
      where: { shopperId: ctx.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Promise.all(
      items.map(async (item) => {
        const bid = item.reservedBidId
          ? await ctx.prisma.bid.findUnique({ where: { id: item.reservedBidId } })
          : null;
        return {
          ...item,
          uiStatus: shoppingRequestUiStatus({
            itemStatus: item.status,
            reservedTravelerId: item.reservedTravelerId,
            bidStatus: bid?.status,
          }),
        };
      }),
    );
  }),
});
