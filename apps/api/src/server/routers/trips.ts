/**
 * Traveler trips + calendar sync — two complementary paths:
 *
 * 1. Cloud (Google / Outlook): `syncCloudCalendar` — OAuth pull from the account.
 * 2. Device (phone iCal / Calendar.app): `syncDeviceCalendar` — the app reads the
 *    local calendar with OS permission and posts events here. This covers flights
 *    people add only on their phone, which never appear in Google/Outlook.
 *
 * Recommended UX: offer BOTH. Many travelers have flights in one place only.
 * We never store email bodies, flight numbers, or PNRs — only minimized fields.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  parseFlightEvents,
  fetchGoogleCalendarEvents,
  fetchOutlookCalendarEvents,
  CALENDAR_PROVIDERS,
  DEVICE_CALENDAR_PROVIDERS,
} from "@manebra/calendar";
import { syncParsedTrips, proposeMatchesForTrip, JOB_ALERT_MIN_CONFIDENCE } from "@manebra/agents/matching";
import { router, verifiedProcedure } from "../trpc.js";

const providerSchema = z.enum(CALENDAR_PROVIDERS);
const deviceProviderSchema = z.enum(DEVICE_CALENDAR_PROVIDERS);

const calendarEventSchema = z.object({
  externalEventId: z.string().min(1).max(255),
  title: z.string().max(500).optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional().nullable(),
  provider: providerSchema.optional(),
});

function assertTraveler(role: string) {
  if (role === "shopper") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only travelers can sync trips." });
  }
}

async function ingestEvents(
  prisma: typeof import("@manebra/db").prisma,
  travelerId: string,
  events: z.infer<typeof calendarEventSchema>[],
  provider: z.infer<typeof providerSchema>,
  defaultCapacityKg?: number,
) {
  const tagged = events.map((e) => ({ ...e, provider: e.provider ?? provider }));
  const { trips, rejected } = parseFlightEvents(tagged);
  const sync = await syncParsedTrips(travelerId, trips, {
    defaultCapacityKg,
    matchNow: true,
  });
  await prisma.calendarConnection.upsert({
    where: { userId_provider: { userId: travelerId, provider } },
    create: { userId: travelerId, provider, lastSyncedAt: new Date() },
    update: { lastSyncedAt: new Date(), revokedAt: null },
  });
  return {
    parsed: trips.length,
    rejected,
    ...sync,
    jobAlertMinConfidence: JOB_ALERT_MIN_CONFIDENCE,
  };
}

export const tripsRouter = router({
  /** List the traveler's own trips (upcoming first). */
  mine: verifiedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.travelerTrip.findMany({
      where: { travelerId: ctx.user.id },
      orderBy: { departureDate: "asc" },
    });
  }),

  /** List connected cloud calendar accounts. */
  calendarConnections: verifiedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.calendarConnection.findMany({
      where: { userId: ctx.user.id },
      select: {
        id: true,
        provider: true,
        calendarId: true,
        lastSyncedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
  }),

  /**
   * Record that the traveler authorized a cloud calendar (Google / Outlook / Apple / ICS).
   * Call after OAuth consent on any device. Tokens are passed per-sync (see syncCloudCalendar)
   * so we don't need to hold long-lived secrets for the MVP.
   */
  connectCalendar: verifiedProcedure
    .input(z.object({ provider: providerSchema, calendarId: z.string().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      assertTraveler(ctx.user.userRole);
      return ctx.prisma.calendarConnection.upsert({
        where: { userId_provider: { userId: ctx.user.id, provider: input.provider } },
        create: {
          userId: ctx.user.id,
          provider: input.provider,
          calendarId: input.calendarId,
        },
        update: {
          calendarId: input.calendarId,
          revokedAt: null,
        },
      });
    }),

  /**
   * Pull ALL calendars from a connected cloud account and create trip + job alerts.
   * Works the same on iOS, Android, web — pass a fresh OAuth access token from
   * the Google / Microsoft sign-in the traveler just completed (any device).
   */
  syncCloudCalendar: verifiedProcedure
    .input(
      z.object({
        provider: z.enum(["google", "outlook"]),
        accessToken: z.string().min(10),
        /** Google only: "all" (default) reads every calendar on the account. */
        calendarIds: z.union([z.literal("all"), z.array(z.string())]).optional(),
        defaultCapacityKg: z.number().int().min(1).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTraveler(ctx.user.userRole);

      const events =
        input.provider === "google"
          ? await fetchGoogleCalendarEvents({
              accessToken: input.accessToken,
              calendarIds: input.calendarIds ?? "all",
            })
          : await fetchOutlookCalendarEvents({ accessToken: input.accessToken });

      const { trips, rejected } = parseFlightEvents(events);
      const sync = await syncParsedTrips(ctx.user.id, trips, {
        defaultCapacityKg: input.defaultCapacityKg,
        matchNow: true,
      });

      await ctx.prisma.calendarConnection.upsert({
        where: { userId_provider: { userId: ctx.user.id, provider: input.provider } },
        create: {
          userId: ctx.user.id,
          provider: input.provider,
          lastSyncedAt: new Date(),
        },
        update: {
          lastSyncedAt: new Date(),
          revokedAt: null,
        },
      });

      return {
        provider: input.provider,
        eventsFetched: events.length,
        flightsParsed: trips.length,
        rejected,
        ...sync,
        jobAlertMinConfidence: JOB_ALERT_MIN_CONFIDENCE,
        note: "Synced from your cloud calendar account — independent of phone OS.",
      };
    }),

  /**
   * Phone / local calendar (iCal, Calendar.app, local device calendars).
   *
   * Covers the common case: traveler adds a flight on their phone and it never
   * syncs to Google or Outlook. The mobile client must:
   *   1. Ask for calendar permission (value-first: "so we can find delivery jobs")
   *   2. Read events from the device calendar store (EventKit on iOS, etc.)
   *   3. POST minimized fields here — we parse flights and send job alerts
   *
   * Server cannot reach the phone calendar by itself; this is the bridge.
   */
  syncDeviceCalendar: verifiedProcedure
    .input(
      z.object({
        /** apple = iPhone/iPad Calendar.app / iCal; ics = imported feed/file */
        provider: deviceProviderSchema.default("apple"),
        events: z.array(calendarEventSchema).min(1).max(200),
        defaultCapacityKg: z.number().int().min(1).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTraveler(ctx.user.userRole);
      const result = await ingestEvents(
        ctx.prisma,
        ctx.user.id,
        input.events,
        input.provider,
        input.defaultCapacityKg,
      );
      return {
        ...result,
        provider: input.provider,
        note: "Synced from your phone calendar — catches flights that are not on Google/Outlook.",
      };
    }),

  /**
   * Generic ingest (tests, bridges). Prefer syncCloudCalendar or syncDeviceCalendar
   * so the source is explicit.
   */
  ingestCalendarEvents: verifiedProcedure
    .input(
      z.object({
        events: z.array(calendarEventSchema).min(1).max(200),
        defaultCapacityKg: z.number().int().min(1).max(50).optional(),
        provider: providerSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTraveler(ctx.user.userRole);
      const provider = input.provider ?? input.events[0]?.provider ?? "google";
      return ingestEvents(ctx.prisma, ctx.user.id, input.events, provider, input.defaultCapacityKg);
    }),

  /** Confirm a low-confidence calendar trip so it can receive job alerts. */
  confirmTrip: verifiedProcedure
    .input(z.object({ tripId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const trip = await ctx.prisma.travelerTrip.findUnique({ where: { id: input.tripId } });
      if (!trip || trip.travelerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Trip not found." });
      }
      const updated = await ctx.prisma.travelerTrip.update({
        where: { id: trip.id },
        data: { confidence: 1 },
      });
      const alerts = await proposeMatchesForTrip(updated.id);
      return { trip: updated, alerts };
    }),

  /**
   * Revoke calendar access: mark connection revoked and delete upcoming trips
   * that have no bids. Funded/in-flight trips are retained for settlement.
   */
  revokeCalendar: verifiedProcedure
    .input(z.object({ provider: providerSchema }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.calendarConnection.updateMany({
        where: { userId: ctx.user.id, provider: input.provider },
        data: { revokedAt: new Date(), tokenCipher: null, syncCursor: null },
      });
      const trips = await ctx.prisma.travelerTrip.findMany({
        where: {
          travelerId: ctx.user.id,
          source: "calendar",
          calendarProvider: input.provider,
          status: "upcoming",
        },
        include: { bids: { select: { id: true, status: true }, take: 1 } },
      });
      let deleted = 0;
      for (const t of trips) {
        if (t.bids.length > 0) continue;
        await ctx.prisma.matchProposal.deleteMany({ where: { tripId: t.id } });
        await ctx.prisma.travelerTrip.delete({ where: { id: t.id } });
        deleted += 1;
      }
      return { deleted };
    }),

  /** Job alerts for this traveler (match proposals + notification inbox). */
  jobAlerts: verifiedProcedure.query(async ({ ctx }) => {
    const proposals = await ctx.prisma.matchProposal.findMany({
      where: { travelerId: ctx.user.id, status: "proposed" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const itemIds = [...new Set(proposals.map((p) => p.itemRequestId))];
    const tripIds = [...new Set(proposals.map((p) => p.tripId))];
    const items = await ctx.prisma.itemRequest.findMany({ where: { id: { in: itemIds } } });
    const trips = await ctx.prisma.travelerTrip.findMany({ where: { id: { in: tripIds } } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const tripById = new Map(trips.map((t) => [t.id, t]));
    return proposals.map((p) => {
      const item = itemById.get(p.itemRequestId);
      const trip = tripById.get(p.tripId);
      return {
        proposalId: p.id,
        score: p.score,
        createdAt: p.createdAt,
        item: item
          ? {
              id: item.id,
              itemName: item.itemName,
              itemCostCents: item.itemCostCents,
              destinationCity: item.destinationCity,
              expiresAt: item.expiresAt,
              category: item.category,
            }
          : null,
        trip: trip
          ? {
              id: trip.id,
              departureDate: trip.departureDate,
              destinationCity: trip.destinationCity,
              source: trip.source,
            }
          : null,
      };
    });
  }),

  dismissAlert: verifiedProcedure
    .input(z.object({ proposalId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const p = await ctx.prisma.matchProposal.findUnique({ where: { id: input.proposalId } });
      if (!p || p.travelerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return ctx.prisma.matchProposal.update({
        where: { id: p.id },
        data: { status: "dismissed" },
      });
    }),
});
