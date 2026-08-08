/**
 * Matching proposer — the server side of the matching agent. ADVISORY-ONLY:
 * it queries candidates, scores them with the pure core, and emits proposals
 * as notifications. It never bids, never moves state. Humans convert proposals
 * into bids through the existing (kernel-gated) flow.
 *
 * Gate config comes from @manebra/shared so the agent and the kernel can never
 * disagree about eligibility.
 */
import { prisma } from "@manebra/db";
import {
  CATEGORIES_BY_DIRECTION,
  NEW_USER_DELIVERY_THRESHOLD,
  NEW_USER_ITEM_CAP_CENTS,
  HIGH_VALUE_ITEM_CENTS,
  HIGH_VALUE_MIN_TRUST,
} from "@manebra/shared";
import { rankTripsForItem, type MatchGateConfig } from "./score";
import { writeJobAlert } from "./job-alert";

import { inngest } from "../events";

const cfg: MatchGateConfig = {
  categoriesByDirection: CATEGORIES_BY_DIRECTION,
  newUserDeliveryThreshold: NEW_USER_DELIVERY_THRESHOLD,
  newUserItemCapCents: NEW_USER_ITEM_CAP_CENTS,
  highValueItemCents: HIGH_VALUE_ITEM_CENTS,
  highValueMinTrust: HIGH_VALUE_MIN_TRUST,
};

/** Notify all strong matches — marketplace jobs are not limited to a podium of 3. */
const TOP_N = 25;

/** Score all live candidate trips for one open item request; emit top-N proposals. */
export async function proposeMatchesForItem(itemRequestId: string): Promise<number> {
  const item = await prisma.itemRequest.findUniqueOrThrow({ where: { id: itemRequestId } });
  if (item.status !== "open") return 0;

  const trips = await prisma.travelerTrip.findMany({
    where: {
      direction: item.direction,
      destinationCity: item.destinationCity,
      status: "upcoming",
      departureDate: { gt: new Date(), lte: item.expiresAt },
    },
    include: { traveler: true },
  });

  const ranked = rankTripsForItem(
    {
      id: item.id, direction: item.direction, destinationCity: item.destinationCity,
      category: item.category, itemCostCents: item.itemCostCents,
      status: item.status, reviewStatus: item.reviewStatus, expiresAt: item.expiresAt,
    },
    trips.map((t: any) => ({
      trip: {
        id: t.id, travelerId: t.travelerId, direction: t.direction,
        destinationCity: t.destinationCity, departureDate: t.departureDate, status: t.status,
      },
      traveler: {
        id: t.traveler.id, isVerified: t.traveler.isVerified, accountStatus: t.traveler.accountStatus,
        trustScore: t.traveler.trustScore, avgRating: t.traveler.avgRating == null ? null : Number(t.traveler.avgRating),
        totalDeliveries: t.traveler.totalDeliveries,
      },
    })),
    cfg,
  ).slice(0, TOP_N);

  for (const m of ranked) {
    // idempotent per (item, trip): skip already-proposed pairs
    const exists = await prisma.matchProposal.findUnique({
      where: { itemRequestId_tripId: { itemRequestId: item.id, tripId: m.trip.id } },
    });
    if (exists) continue;
    await prisma.matchProposal.create({
      data: { itemRequestId: item.id, tripId: m.trip.id, travelerId: m.traveler.id, score: m.score, status: "proposed" },
    });
    await writeJobAlert({
      travelerId: m.traveler.id,
      itemRequestId: item.id,
      tripId: m.trip.id,
      score: m.score,
      itemName: item.itemName,
      destinationCity: item.destinationCity,
      itemCostCents: item.itemCostCents,
    });
    try {
      await inngest.send({
        name: "agents/match.proposed",
        data: {
          itemRequestId: item.id,
          tripId: m.trip.id,
          travelerId: m.traveler.id,
          score: m.score,
          itemName: item.itemName,
          destinationCity: item.destinationCity,
          itemCostCents: item.itemCostCents,
          source: "item_sweep",
        },
      });
    } catch {
      // Inngest optional in local/MCP; in-app notification already written
    }
  }
  return ranked.length;
}
