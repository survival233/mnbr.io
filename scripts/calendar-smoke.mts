/**
 * Calendar sync smoke — seed marketplace → sync traveler calendar → job alerts.
 * Run: npx tsx scripts/calendar-smoke.mts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

try {
  for (const line of readFileSync(new URL("./smoke-local.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}
process.env.DATABASE_URL ??= "postgresql://ebenblanks@localhost:5432/manebra";
process.env.DIRECT_URL ??= process.env.DATABASE_URL;
process.env.INNGEST_EVENT_KEY ??= "local";
process.env.INNGEST_DEV ??= "1";

const { prisma } = await import("@manebra/db");
const { parseFlightEvents } = await import("@manebra/calendar");
const { syncParsedTrips } = await import("@manebra/agents/matching");

const email = `cal-traveler-${Date.now()}@manebra.test`;
const traveler = await prisma.user.create({
  data: {
    id: randomUUID(),
    email,
    fullName: "Calendar Traveler",
    userRole: "traveler",
    isVerified: true,
    trustScore: 140,
    totalDeliveries: 12,
    avgRating: 4.8,
  },
});
const shopper = await prisma.user.create({
  data: {
    id: randomUUID(),
    email: `cal-shopper-${Date.now()}@manebra.test`,
    fullName: "Calendar Shopper",
    userRole: "shopper",
    isVerified: true,
  },
});

const item = await prisma.itemRequest.create({
  data: {
    shopperId: shopper.id,
    itemName: "AirPods Pro",
    itemCostCents: 249_00,
    category: "electronics",
    direction: "us_to_gh",
    destinationCity: "Accra",
    reviewStatus: "approved",
    status: "open",
    expiresAt: new Date(Date.now() + 20 * 86400_000),
  },
});

const { trips, rejected } = parseFlightEvents([
  {
    externalEventId: "smoke-flight-1",
    title: "Delta flight DL406 JFK → ACC",
    location: "Kotoka International Airport",
    startsAt: new Date(Date.now() + 10 * 86400_000).toISOString(),
    provider: "google",
  },
  {
    externalEventId: "smoke-noise",
    title: "Dentist appointment",
    startsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
  },
]);

console.log(`parsed ${trips.length} flight(s), rejected ${rejected.length} (noise)`);
const sync = await syncParsedTrips(traveler.id, trips, { matchNow: true });
console.log("sync:", JSON.stringify(sync, null, 2));

const alerts = await prisma.notification.findMany({
  where: { userId: traveler.id, kind: "job_alert" },
});
console.log(`job alerts: ${alerts.length}`);
for (const a of alerts) console.log(`  · ${a.title}`);

const proposals = await prisma.matchProposal.findMany({ where: { travelerId: traveler.id } });
if (alerts.length < 1 || proposals.length < 1 || sync.upserted[0]?.alerts < 1) {
  console.error("CALENDAR SMOKE FAILED");
  process.exit(1);
}
console.log("\nCALENDAR SMOKE PASSED — traveler notified of Accra shopper request after calendar sync");
process.exit(0);
