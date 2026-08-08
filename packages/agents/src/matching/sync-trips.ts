/**
 * Upsert calendar-parsed trips and immediately reverse-match open shopper jobs.
 * Called from the trips tRPC router and MCP tools.
 */
import { prisma, type TripStatus } from "@manebra/db";
import type { ParsedFlightTrip } from "@manebra/calendar";
import { proposeMatchesForTrip, JOB_ALERT_MIN_CONFIDENCE } from "./propose-for-trip";

const DEFAULT_CAPACITY_KG = 23;

export interface SyncTripsResult {
  upserted: Array<{ tripId: string; externalEventId: string; created: boolean; alerts: number }>;
  skippedLowConfidence: number;
  skippedPast: number;
}

export async function syncParsedTrips(
  travelerId: string,
  trips: ParsedFlightTrip[],
  opts: { defaultCapacityKg?: number; matchNow?: boolean } = {},
): Promise<SyncTripsResult> {
  const capacity = opts.defaultCapacityKg ?? DEFAULT_CAPACITY_KG;
  const matchNow = opts.matchNow !== false;
  const now = Date.now();
  const result: SyncTripsResult = { upserted: [], skippedLowConfidence: 0, skippedPast: 0 };

  for (const t of trips) {
    const isPast = t.departureDate.getTime() <= now;
    const status: TripStatus = isPast ? "completed" : "upcoming";
    if (isPast) result.skippedPast += 1;

    const existing = await prisma.travelerTrip.findUnique({
      where: { travelerId_externalEventId: { travelerId, externalEventId: t.externalEventId } },
    });

    const nextStatus: TripStatus =
      existing?.status === "in_progress" ? existing.status : status;

    const data = {
      direction: t.direction,
      departureCity: t.departureCity,
      destinationCity: t.destinationCity,
      departureDate: t.departureDate,
      returnDate: t.returnDate,
      luggageCapacityKg: existing?.luggageCapacityKg ?? capacity,
      status: nextStatus,
      source: "calendar" as const,
      calendarProvider: t.provider,
      confidence: t.confidence,
      syncedAt: new Date(),
    };

    const trip = existing
      ? await prisma.travelerTrip.update({ where: { id: existing.id }, data })
      : await prisma.travelerTrip.create({
          data: { travelerId, externalEventId: t.externalEventId, ...data },
        });

    let alerts = 0;
    if (matchNow && trip.status === "upcoming" && trip.confidence >= JOB_ALERT_MIN_CONFIDENCE) {
      alerts = await proposeMatchesForTrip(trip.id);
    } else if (trip.confidence < JOB_ALERT_MIN_CONFIDENCE) {
      result.skippedLowConfidence += 1;
    }

    result.upserted.push({
      tripId: trip.id,
      externalEventId: t.externalEventId,
      created: !existing,
      alerts,
    });
  }
  return result;
}
