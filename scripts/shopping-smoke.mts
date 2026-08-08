/**
 * Live shopping smoke: Google Shopping search → select listing → create request →
 * traveler Accept. Requires SERPAPI_API_KEY (not store APIs).
 * Run: npm run smoke:shop
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

for (const rel of ["./smoke-local.env", "../apps/agent-cli/.env"] as const) {
  try {
    for (const line of readFileSync(new URL(rel, import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}
process.env.DATABASE_URL ??= "postgresql://ebenblanks@localhost:5432/manebra";
process.env.DIRECT_URL ??= process.env.DATABASE_URL;
process.env.INNGEST_EVENT_KEY ??= "local";
process.env.INNGEST_DEV ??= "1";

if (!process.env.SERPAPI_API_KEY?.trim()) {
  console.error("SERPAPI_API_KEY missing — add it to apps/agent-cli/.env for live product search.");
  console.error("https://serpapi.com  (Google Shopping aggregator — not Apple/BestBuy/Walmart APIs)");
  process.exit(1);
}

const { prisma } = await import("@manebra/db");
const { searchProducts } = await import("@manebra/catalog");
const { syncParsedTrips } = await import("@manebra/agents/matching");
const { parseFlightEvents } = await import("@manebra/calendar");
const { appRouter } = await import("../apps/api/src/server/routers/_app.js");

const shopper = await prisma.user.create({
  data: {
    id: randomUUID(),
    email: `shop-live-${Date.now()}@manebra.test`,
    fullName: "Live Shopper",
    userRole: "shopper",
    isVerified: true,
  },
});
const traveler = await prisma.user.create({
  data: {
    id: randomUUID(),
    email: `trav-live-${Date.now()}@manebra.test`,
    fullName: "Live Traveler",
    userRole: "traveler",
    isVerified: true,
    trustScore: 150,
    totalDeliveries: 20,
    avgRating: 4.9,
  },
});

const caller = (userId: string) => appRouter.createCaller({ prisma, userId });

console.log("live search: iPhone 16 Pro …");
const results = await searchProducts({ query: "iPhone 16 Pro", shoppingCity: "New York" });
if (!results.listings.length) {
  console.error("No verified-store listings returned from Google Shopping.");
  process.exit(1);
}
for (const l of results.listings) {
  console.log(`  ${l.storeName.padEnd(12)} $${(l.priceCents / 100).toFixed(2)}  ${l.availabilityLabel}`);
  console.log(`    ${l.productUrl.slice(0, 80)}`);
}
const pick = results.listings[0]!;

const { trips } = parseFlightEvents([
  {
    externalEventId: `shop-live-${Date.now()}`,
    title: "Flight JFK → Accra",
    startsAt: new Date(Date.now() + 12 * 86400_000),
    provider: "google",
  },
]);
const sync = await syncParsedTrips(traveler.id, trips, { matchNow: false });
const tripId = sync.upserted[0]?.tripId;
if (!tripId) throw new Error("traveler trip not created");

const created = await caller(shopper.id).items.createFromListing({
  listingId: pick.listingId,
  shoppingCity: "New York",
  destinationCity: "Accra",
  neededBy: new Date(Date.now() + 18 * 86400_000),
  quantity: 1,
});
console.log(`request ${created.requestId} @ ${created.product.retailer} $${(created.product.priceCents! / 100).toFixed(2)} status=${created.uiStatus}`);

const { proposeMatchesForTrip } = await import("@manebra/agents/matching");
await proposeMatchesForTrip(tripId);

const jobs = await caller(traveler.id).matches.myJobs();
const job = jobs.find((j) => j.product.title === pick.productTitle) ?? jobs[0];
if (!job) throw new Error("expected job alert");
const accepted = await caller(traveler.id).matches.accept({ proposalId: job.proposalId });
console.log(`accepted → ${accepted.uiStatus}`);

console.log("\nLIVE SHOPPING SMOKE PASSED");
process.exit(0);
