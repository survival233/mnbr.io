/**
 * Reverse matching — after a traveler trip is synced from calendar, find open
 * shopper item requests heading to the same city and emit job-alert proposals.
 * Same gates / ranker as proposeMatchesForItem; opposite query direction.
 */
import { prisma } from "@manebra/db";
import {
  CATEGORIES_BY_DIRECTION,
  NEW_USER_DELIVERY_THRESHOLD,
  NEW_USER_ITEM_CAP_CENTS,
  HIGH_VALUE_ITEM_CENTS,
  HIGH_VALUE_MIN_TRUST,
} from "@manebra/shared";
import { scoreMatch, type MatchGateConfig } from "./score";
import { writeJobAlert } from "./job-alert";
import { inngest } from "../events";

const cfg: MatchGateConfig = {
  categoriesByDirection: CATEGORIES_BY_DIRECTION,
  newUserDeliveryThreshold: NEW_USER_DELIVERY_THRESHOLD,
  newUserItemCapCents: NEW_USER_ITEM_CAP_CENTS,
  highValueItemCents: HIGH_VALUE_ITEM_CENTS,
  highValueMinTrust: HIGH_VALUE_MIN_TRUST,
};

const TOP_N = 5;
/** Calendar parses below this must be confirmed by the traveler before alerts. */
export const JOB_ALERT_MIN_CONFIDENCE = 0.7;

export async function proposeMatchesForTrip(tripId: string): Promise<number> {
  const trip = await prisma.travelerTrip.findUnique({
    where: { id: tripId },
    include: { traveler: true },
  });
  if (!trip || trip.status !== "upcoming") return 0;
  if (trip.departureDate.getTime() <= Date.now()) return 0;
  if (trip.confidence < JOB_ALERT_MIN_CONFIDENCE) return 0;

  const items = await prisma.itemRequest.findMany({
    where: {
      status: "open",
      reviewStatus: { in: ["approved", "auto_approved"] },
      direction: trip.direction,
      destinationCity: trip.destinationCity,
      expiresAt: { gte: trip.departureDate },
    },
  });

  const traveler = {
    id: trip.traveler.id,
    isVerified: trip.traveler.isVerified,
    accountStatus: trip.traveler.accountStatus,
    trustScore: trip.traveler.trustScore,
    avgRating: trip.traveler.avgRating == null ? null : Number(trip.traveler.avgRating),
    totalDeliveries: trip.traveler.totalDeliveries,
  };

  const tripCand = {
    id: trip.id,
    travelerId: trip.travelerId,
    direction: trip.direction,
    destinationCity: trip.destinationCity,
    departureDate: trip.departureDate,
    status: trip.status,
  };

  const ranked = items
    .map((item) => {
      const result = scoreMatch(
        {
          id: item.id,
          direction: item.direction,
          destinationCity: item.destinationCity,
          category: item.category,
          itemCostCents: item.itemCostCents,
          status: item.status,
          reviewStatus: item.reviewStatus,
          expiresAt: item.expiresAt,
        },
        tripCand,
        traveler,
        cfg,
      );
      return { item, result };
    })
    .filter((r): r is typeof r & { result: { eligible: true; score: number } } => r.result.eligible)
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, TOP_N);

  let created = 0;
  for (const m of ranked) {
    const exists = await prisma.matchProposal.findUnique({
      where: { itemRequestId_tripId: { itemRequestId: m.item.id, tripId: trip.id } },
    });
    if (exists) continue;
    await prisma.matchProposal.create({
      data: {
        itemRequestId: m.item.id,
        tripId: trip.id,
        travelerId: trip.travelerId,
        score: m.result.score,
        status: "proposed",
      },
    });
    await writeJobAlert({
      travelerId: trip.travelerId,
      itemRequestId: m.item.id,
      tripId: trip.id,
      score: m.result.score,
      itemName: m.item.itemName,
      destinationCity: m.item.destinationCity,
      itemCostCents: m.item.itemCostCents,
    });
    try {
      await inngest.send({
        name: "agents/match.proposed",
        data: {
          itemRequestId: m.item.id,
          tripId: trip.id,
          travelerId: trip.travelerId,
          score: m.result.score,
          itemName: m.item.itemName,
          destinationCity: m.item.destinationCity,
          itemCostCents: m.item.itemCostCents,
          source: "trip_sync",
        },
      });
    } catch {
      // Inngest optional in local/MCP; in-app notification already written
    }
    created += 1;
  }
  return created;
}
