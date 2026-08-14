/**
 * Upsert Ama / Kofi / Nana + upcoming Accra trips for Linq settlement beta.
 * Run: npm run seed:linq-travelers
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LINQ_TRAVELERS } from "../apps/shopper-agent/src/traveler-seeds.mts";

for (const rel of ["apps/api/.env", "apps/shopper-agent/.env"]) {
  try {
    for (const line of readFileSync(resolve(rel), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* optional */
  }
}

const { prisma } = await import("@manebra/db");

const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

for (const t of LINQ_TRAVELERS) {
  await prisma.user.upsert({
    where: { id: t.id },
    create: {
      id: t.id,
      email: t.email,
      fullName: t.name,
      userRole: "both",
      isVerified: true,
      trustScore: t.trustScore,
      avgRating: t.avgRating ?? undefined,
      totalDeliveries: t.totalDeliveries,
      accountStatus: "active",
    },
    update: {
      fullName: t.name,
      isVerified: true,
      trustScore: t.trustScore,
      avgRating: t.avgRating ?? undefined,
      totalDeliveries: t.totalDeliveries,
      accountStatus: "active",
    },
  });

  const existing = await prisma.travelerTrip.findFirst({
    where: { travelerId: t.id, status: "upcoming", destinationCity: "Accra" },
    orderBy: { departureDate: "asc" },
  });
  if (existing) {
    await prisma.travelerTrip.update({
      where: { id: existing.id },
      data: { departureDate: day(t.daysUntilDep), direction: "us_to_gh", departureCity: "New York" },
    });
    console.log(`updated trip ${existing.id.slice(0, 8)}… for ${t.name}`);
  } else {
    const trip = await prisma.travelerTrip.create({
      data: {
        travelerId: t.id,
        direction: "us_to_gh",
        departureCity: "New York",
        destinationCity: "Accra",
        departureDate: day(t.daysUntilDep),
        luggageCapacityKg: 23,
        status: "upcoming",
        source: "manual",
      },
    });
    console.log(`created trip ${trip.id.slice(0, 8)}… for ${t.name}`);
  }
}

console.log("Linq travelers seeded.");
await prisma.$disconnect();
