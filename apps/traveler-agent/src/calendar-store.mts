/**
 * Calendar link + derived trips on the marketplace trip store (file or Postgres).
 * Not a second trip table.
 */
import {
  createMemoryCalendarStore,
  type CalendarLinkRecord,
  type CalendarStore,
  type CalendarTripRecord,
} from "./calendar-connect.mts";

function tripFromStored(t: {
  id: string;
  travelerId: string;
  travelerName: string;
  externalEventId?: string;
  originCity: string;
  destinationCity: string;
  departureDate: Date;
  departAt?: Date | null;
  arriveAt?: Date | null;
  timezone?: string | null;
  status: string;
  optedIn: boolean;
  optedInAt?: Date | null;
  retentionUntil?: Date | null;
  confidence?: number;
  source?: string;
}): CalendarTripRecord | null {
  if (t.source !== "calendar" || !t.externalEventId) return null;
  const status = t.status === "upcoming" || t.status === "declined" ? t.status : "proposed";
  return {
    id: t.id,
    travelerId: t.travelerId,
    travelerName: t.travelerName,
    externalEventId: t.externalEventId,
    originCity: t.originCity,
    destinationCity: t.destinationCity,
    departureDate: t.departureDate,
    departAt: t.departAt ?? t.departureDate,
    arriveAt: t.arriveAt ?? null,
    timezone: t.timezone ?? "UTC",
    status,
    optedIn: t.optedIn,
    optedInAt: t.optedInAt ?? null,
    retentionUntil: t.retentionUntil ?? t.departureDate,
    confidence: t.confidence ?? 1,
    source: "calendar",
  };
}

export function marketplaceCalendarStore(): CalendarStore {
  return {
    async getLink(travelerId) {
      const { getCalendarLink } = await import("@manebra/db");
      const row = await getCalendarLink(travelerId);
      if (!row) return null;
      return {
        travelerId: row.travelerId,
        provider: row.provider === "apple" ? "apple" : "google",
        status: row.status,
        scopes: row.scopes.split(/\s+/).filter(Boolean),
        tokenCipher: row.tokenCipher,
        refreshCipher: row.refreshCipher,
        expiresAt: row.expiresAt,
        connectedAt: row.connectedAt,
        revokedAt: row.revokedAt,
      };
    },
    async saveLink(link: CalendarLinkRecord) {
      const { saveCalendarLink } = await import("@manebra/db");
      await saveCalendarLink({
        travelerId: link.travelerId,
        provider: link.provider,
        status: link.status,
        scopes: link.scopes.join(" "),
        tokenCipher: link.tokenCipher,
        refreshCipher: link.refreshCipher,
        expiresAt: link.expiresAt,
        connectedAt: link.connectedAt,
        revokedAt: link.revokedAt,
      });
    },
    async deleteLink(travelerId) {
      const { deleteCalendarLink } = await import("@manebra/db");
      await deleteCalendarLink(travelerId);
    },
    async listTrips(travelerId) {
      const { listTripsForTraveler } = await import("@manebra/db");
      const rows = await listTripsForTraveler(travelerId);
      return rows.map(tripFromStored).filter((t): t is CalendarTripRecord => Boolean(t));
    },
    async saveTrip(trip) {
      const { upsertCalendarTrip, setCalendarTripChoice } = await import("@manebra/db");
      const saved = await upsertCalendarTrip({
        travelerId: trip.travelerId,
        travelerName: trip.travelerName,
        externalEventId: trip.externalEventId,
        originCity: trip.originCity,
        destinationCity: trip.destinationCity,
        departureDate: trip.departureDate,
        departAt: trip.departAt,
        arriveAt: trip.arriveAt,
        timezone: trip.timezone,
        confidence: trip.confidence,
        retentionUntil: trip.retentionUntil,
      });
      if (trip.optedIn || trip.status === "declined") {
        const chosen = await setCalendarTripChoice({
          travelerId: trip.travelerId,
          externalEventId: trip.externalEventId,
          optedIn: trip.optedIn,
          optedInAt: trip.optedInAt ?? new Date(),
          retentionUntil: trip.retentionUntil,
        });
        const mapped = chosen ? tripFromStored(chosen) : null;
        return mapped ?? { ...trip, id: saved.id };
      }
      return tripFromStored(saved) ?? { ...trip, id: saved.id };
    },
    async deleteTrips(travelerId, ids) {
      const { deleteCalendarTrips } = await import("@manebra/db");
      return deleteCalendarTrips(travelerId, ids);
    },
  };
}

/** Postgres when it is reachable; memory if the trip store is down so Phase 0 chat still runs. */
export function resilientCalendarStore(): CalendarStore {
  const memory = createMemoryCalendarStore();
  const remote = marketplaceCalendarStore();
  let useMemory = false;

  async function run<T>(op: (store: CalendarStore) => Promise<T>): Promise<T> {
    if (useMemory) return op(memory);
    try {
      return await op(remote);
    } catch (e: unknown) {
      useMemory = true;
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[traveler-agent] calendar store unavailable (${message}); using memory`);
      return op(memory);
    }
  }

  return {
    getLink: (travelerId) => run((s) => s.getLink(travelerId)),
    saveLink: (link) => run((s) => s.saveLink(link)),
    deleteLink: (travelerId) => run((s) => s.deleteLink(travelerId)),
    listTrips: (travelerId) => run((s) => s.listTrips(travelerId)),
    saveTrip: (trip) => run((s) => s.saveTrip(trip)),
    deleteTrips: (travelerId, ids) => run((s) => s.deleteTrips(travelerId, ids)),
  };
}
