/**
 * Inngest functions — [MERGE] the three settlement/agent registrations.
 * Add these to your serve(...) alongside existing functions.
 */
import { prisma } from "@manebra/db";
import { inngest } from "./client.js";
import { reconcileEscrows, onReleaseScheduled } from "@manebra/settlement/server";
import { proposeMatchesForItem } from "@manebra/agents/matching";

/** 1. Escrow release after the 48h dispute window (final settlement). */
export const escrowRelease = inngest.createFunction(
  { id: "escrow-release", triggers: [{ event: "settlement/escrow.release.scheduled" }] },
  async ({ event, step }) => {
    await step.sleepUntil("dispute-window", new Date(event.data.notBefore as number));
    await step.run("release", () => onReleaseScheduled(event.data.bidId as string));
  },
);

/** 2. Reconciliation: heal escrow-mirror drift from chain truth; page anomalies. */
export const settlementReconcile = inngest.createFunction(
  { id: "settlement-reconcile", triggers: [{ cron: "*/5 * * * *" }] },
  async ({ step }) => {
    const report = await step.run("reconcile", () => reconcileEscrows());
    if (report.anomalies.length > 0) {
      await step.run("page", () =>
        inngest.send({ name: "settlement/reconcile.anomalies", data: { count: report.anomalies.length, anomalies: report.anomalies } }),
      );
    }
    return report;
  },
);

/** 3. Matching agent sweep over open, approved items (advisory proposals). */
export const matchingSweep = inngest.createFunction(
  { id: "matching-sweep", triggers: [{ cron: "0 * * * *" }] },
  async ({ step }) => {
    const items = await prisma.itemRequest.findMany({
      where: { status: "open", reviewStatus: { in: ["approved", "auto_approved"] } },
      select: { id: true },
    });
    let proposed = 0;
    for (const it of items) {
      proposed += await step.run(`match-${it.id}`, () => proposeMatchesForItem(it.id));
    }
    return { items: items.length, proposed };
  },
);

/**
 * Push hook for job alerts. The in-app Notification row is written at proposal
 * time (so local/MCP demos work without Inngest); this step is where APNs/FCM
 * delivery plugs in later.
 */
export const onMatchProposed = inngest.createFunction(
  { id: "on-match-proposed", triggers: [{ event: "agents/match.proposed" }] },
  async ({ event, logger }) => {
    logger.info("match proposed — deliver push when wired", event.data);
  },
);

/** After calendar trips sync, reverse-match open shopper requests (event-driven). */
export const onTripsSynced = inngest.createFunction(
  { id: "on-trips-synced", triggers: [{ event: "trips/calendar.synced" }] },
  async ({ event, step }) => {
    const tripIds = (event.data as { tripIds: string[] }).tripIds ?? [];
    let proposed = 0;
    for (const tripId of tripIds) {
      proposed += await step.run(`match-trip-${tripId}`, () =>
        import("@manebra/agents/matching").then((m) => m.proposeMatchesForTrip(tripId)),
      );
    }
    return { trips: tripIds.length, proposed };
  },
);

export const onNegotiationAgreed = inngest.createFunction(
  { id: "on-negotiation-agreed", triggers: [{ event: "agents/negotiation.agreed" }] },
  async ({ event, logger }) => logger.info("negotiation agreed", event.data),
);

export const functions = [
  escrowRelease,
  settlementReconcile,
  matchingSweep,
  onMatchProposed,
  onTripsSynced,
  onNegotiationAgreed,
];
