/**
 * Persist booked trips + surface earn jobs when DATABASE_URL is available.
 */
import { createHash } from "node:crypto";
import { suggestedTravelerFeeCents, computeFees } from "@manebra/shared";
import { cityFromAirport, type FlightBooking } from "@manebra/flights";
import { normalizeCity } from "@manebra/calendar";
import { hubCity, sameMetro } from "@manebra/geo";
import { upsertLiveTrip, listFundedOffers, updateOffer, getOffer } from "@manebra/db";

export type EarnOffer = {
  proposalId: string;
  itemRequestId: string;
  itemName: string;
  destinationCity: string;
  feeCents: number;
  score: number;
  merchant?: string;
  itemCostCents?: number;
};

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

async function getPrisma() {
  const { prisma } = await import("@manebra/db");
  return prisma;
}

function identityUuid(identity: string): string {
  const hash = createHash("sha256").update(`manebra-traveler:${identity}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function ensureTravelerUser(identity: string, displayName?: string) {
  const prisma = await getPrisma();
  const id = identityUuid(identity);
  const email = `${id.replace(/-/g, "").slice(0, 12)}@linq.manebra.local`;
  const existing = await prisma.user.findUnique({ where: { id } });
  if (existing) {
    if (existing.userRole === "shopper") {
      return prisma.user.update({ where: { id }, data: { userRole: "both" } });
    }
    return existing;
  }
  return prisma.user.create({
    data: {
      id,
      email,
      fullName: displayName ?? `Traveler ${identity.slice(-6)}`,
      phone: identity.startsWith("+") || /^\d+$/.test(identity) ? identity : null,
      userRole: "traveler",
      isVerified: true,
      trustScore: 120,
    },
  });
}

export async function persistBookedTrip(args: {
  identity: string;
  booking: FlightBooking;
}): Promise<{ tripId: string | null; earnOffers: EarnOffer[] }> {
  const { booking } = args;
  const depCity =
    hubCity(cityFromAirport(booking.offer.origin)) ??
    normalizeCity(cityFromAirport(booking.offer.origin)) ??
    cityFromAirport(booking.offer.origin);
  const destCity =
    hubCity(cityFromAirport(booking.offer.destination)) ??
    normalizeCity(cityFromAirport(booking.offer.destination)) ??
    cityFromAirport(booking.offer.destination);

  try {
    await upsertLiveTrip({
      travelerId: args.identity,
      travelerName: `Traveler ${args.identity.slice(-4)}`,
      originCity: depCity,
      destinationCity: destCity,
      departureDate: booking.offer.departAt,
      optedIn: false,
    });
  } catch (e: any) {
    console.warn(`[traveler-bridge] marketplace trip skipped: ${e?.message ?? e}`);
  }

  try {
    const open = (await listFundedOffers()).filter(
      (o) => o.destinationCity && sameMetro(o.destinationCity, destCity),
    );
    return {
      tripId: null,
      earnOffers: open.slice(0, 3).map((o) => ({
        proposalId: `mkt-${o.id}`,
        itemRequestId: o.id,
        itemName: o.item,
        destinationCity: o.destinationCity ?? destCity,
        feeCents: o.travelerFeeCents || o.totalCents,
        merchant: o.nextTravelerName ?? undefined,
        itemCostCents: o.itemCostCents,
        score: 90,
      })),
    };
  } catch {
    return { tripId: null, earnOffers: [] };
  }
}

export async function acceptEarnOffer(args: {
  identity: string;
  proposalId: string;
}): Promise<{ ok: boolean; message: string }> {
  if (args.proposalId.startsWith("mkt-")) {
    const id = args.proposalId.slice(4);
    const offer = await getOffer(id);
    if (!offer || (offer.status !== "offered" && offer.status !== "funded" && offer.status !== "accepted")) {
      return { ok: false, message: "That request isn’t available anymore." };
    }
    if (offer.status === "offered") {
      await updateOffer(id, { status: "accepted", notifiedShopper: false });
    }
    return {
      ok: true,
      message: `Accepted. Shop with your card — never the shopper’s.`,
    };
  }
  if (!dbConfigured() || args.proposalId.startsWith("local-") || args.proposalId.startsWith("hint-")) {
    return {
      ok: true,
      message:
        "You’re opted in to Shop & Deliver on this trip. When a shopper funds escrow, I’ll walk you through pickup and handover.",
    };
  }
  try {
    const prisma = await getPrisma();
    const user = await ensureTravelerUser(args.identity);
    const proposal = await prisma.matchProposal.findFirst({
      where: { id: args.proposalId, travelerId: user.id, status: "proposed" },
    });
    if (!proposal) return { ok: false, message: "That request isn’t available anymore." };

    const item = await prisma.itemRequest.findUnique({ where: { id: proposal.itemRequestId } });
    if (!item || item.status !== "open") return { ok: false, message: "That request already closed." };

    const fee = suggestedTravelerFeeCents(item.itemCostCents);
    const fees = computeFees(item.itemCostCents, fee);

    await prisma.$transaction(async (tx) => {
      await tx.itemRequest.update({
        where: { id: item.id },
        data: { reservedTravelerId: user.id },
      });
      await tx.matchProposal.update({
        where: { id: proposal.id },
        data: { status: "converted" },
      });
      await tx.matchProposal.updateMany({
        where: { itemRequestId: item.id, status: "proposed", id: { not: proposal.id } },
        data: { status: "dismissed" },
      });
      await tx.bid.create({
        data: {
          itemRequestId: item.id,
          travelerId: user.id,
          tripId: proposal.tripId,
          itemCostCentsSnapshot: item.itemCostCents,
          travelerFeeCents: fee,
          commissionCents: fees.commissionCents,
          totalCents: fees.totalCents,
          promisedDeliveryDate: item.expiresAt,
          status: "pending",
          expiresAt: new Date(Date.now() + 72 * 3600_000),
        },
      });
    });

    return {
      ok: true,
      message: `Locked in — you’ll earn about $${(fee / 100).toFixed(0)} for “${item.itemName}” to ${item.destinationCity}. I’ll ping you when the shopper funds.`,
    };
  } catch (e: any) {
    console.warn(`[traveler-bridge] accept failed: ${e?.message ?? e}`);
    return { ok: false, message: "Couldn’t accept that job right now — try again shortly." };
  }
}
