/**
 * Shared marketplace for Shopper + Traveler.
 * Postgres when DATABASE_URL is set (Render). Local JSON only if no DATABASE_URL
 * (npm run demo). JSON is never the source of truth on Render.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Prisma = import("@prisma/client").PrismaClient;

async function getPrisma(): Promise<Prisma> {
  const { prisma } = await import("./client");
  return prisma;
}

export type OfferStatus = "offered" | "accepted" | "declined" | "funded" | "released";

export type StoredOffer = {
  id: string;
  travelerId: string;
  travelerName: string;
  item: string;
  itemCostCents: number;
  travelerFeeCents: number;
  totalCents: number;
  needBy: Date | null;
  destinationCity: string | null;
  bidId: string;
  escrowId: string;
  handoverCode: string;
  status: OfferStatus;
  shopperKey?: string | null;
  shopperChatId?: string | null;
  notifiedShopper: boolean;
  notifiedTraveler: boolean;
  notifiedTravelerFunded: boolean;
  nextTravelerId?: string | null;
  nextTravelerName?: string | null;
  createdAt: Date;
};

export type StoredTrip = {
  id: string;
  travelerId: string;
  travelerName: string;
  originCity: string;
  destinationCity: string;
  departureDate: Date;
  optedIn: boolean;
  status: string;
};

type FileStore = {
  offers: StoredOffer[];
  trips: StoredTrip[];
};

let ensured = false;

export function marketplaceConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function isStaleDemoItem(item: string): boolean {
  return /airpods/i.test(item) || /sealed electronics parcel/i.test(item);
}

function filePath(): string {
  return process.env.DEMO_MARKETPLACE_PATH?.trim() || ".demo-marketplace.json";
}

function loadFile(): FileStore {
  try {
    const raw = JSON.parse(readFileSync(filePath(), "utf8")) as {
      offers?: StoredOffer[];
      trips?: StoredTrip[];
      carries?: Array<Record<string, unknown>>;
    };
    const offers = Array.isArray(raw.offers)
      ? raw.offers.map(hydrateOffer)
      : Array.isArray(raw.carries)
        ? raw.carries.map(carryToOffer)
        : [];
    const trips = Array.isArray(raw.trips) ? raw.trips.map(hydrateTrip) : [];
    return { offers, trips };
  } catch {
    return { offers: [], trips: [] };
  }
}

function saveFile(store: FileStore): void {
  const p = filePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify(
      {
        offers: store.offers,
        trips: store.trips,
        carries: [],
      },
      null,
      2,
    ),
  );
}

function hydrateOffer(o: StoredOffer): StoredOffer {
  return {
    ...o,
    needBy: o.needBy ? new Date(o.needBy) : null,
    createdAt: new Date(o.createdAt),
  };
}

function hydrateTrip(t: StoredTrip): StoredTrip {
  return { ...t, departureDate: new Date(t.departureDate) };
}

function carryToOffer(c: Record<string, unknown>): StoredOffer {
  return {
    id: String(c.id ?? ""),
    travelerId: String(c.travelerId ?? ""),
    travelerName: String(c.travelerName ?? "Traveler"),
    item: String(c.item ?? ""),
    itemCostCents: Number(c.itemCostCents ?? 0),
    travelerFeeCents: Number(c.travelerFeeCents ?? 0),
    totalCents: Number(c.totalCents ?? 0),
    needBy: c.needBy ? new Date(String(c.needBy)) : null,
    destinationCity: c.destinationCity ? String(c.destinationCity) : null,
    bidId: String(c.bidId ?? c.id ?? ""),
    escrowId: String(c.escrowId ?? ""),
    handoverCode: String(c.handoverCode ?? ""),
    status: (c.status as OfferStatus) || "offered",
    shopperKey: c.shopperKey ? String(c.shopperKey) : null,
    shopperChatId: c.shopperChatId ? String(c.shopperChatId) : null,
    notifiedShopper: Boolean(c.notifiedShopper),
    notifiedTraveler: Boolean(c.notifiedTraveler),
    notifiedTravelerFunded: Boolean(c.notifiedTravelerFunded),
    nextTravelerId: c.nextTravelerId ? String(c.nextTravelerId) : null,
    nextTravelerName: c.nextTravelerName ? String(c.nextTravelerName) : null,
    createdAt: new Date(Number(c.createdAt ?? Date.now())),
  };
}

function rowToOffer(r: {
  id: string;
  travelerId: string;
  travelerName: string;
  item: string;
  itemCostCents: number;
  travelerFeeCents: number;
  totalCents: number;
  needBy: Date | null;
  destinationCity: string | null;
  bidId: string;
  escrowId: string;
  handoverCode: string;
  status: string;
  shopperKey: string | null;
  shopperChatId: string | null;
  notifiedShopper: boolean;
  notifiedTraveler: boolean;
  notifiedTravelerFunded: boolean;
  nextTravelerId: string | null;
  nextTravelerName: string | null;
  createdAt: Date;
}): StoredOffer {
  return {
    id: r.id,
    travelerId: r.travelerId,
    travelerName: r.travelerName,
    item: r.item,
    itemCostCents: r.itemCostCents,
    travelerFeeCents: r.travelerFeeCents,
    totalCents: r.totalCents,
    needBy: r.needBy,
    destinationCity: r.destinationCity,
    bidId: r.bidId,
    escrowId: r.escrowId,
    handoverCode: r.handoverCode,
    status: (r.status as OfferStatus) || "offered",
    shopperKey: r.shopperKey,
    shopperChatId: r.shopperChatId,
    notifiedShopper: r.notifiedShopper,
    notifiedTraveler: r.notifiedTraveler,
    notifiedTravelerFunded: r.notifiedTravelerFunded,
    nextTravelerId: r.nextTravelerId,
    nextTravelerName: r.nextTravelerName,
    createdAt: r.createdAt,
  };
}

async function ensurePg(): Promise<void> {
  if (ensured) return;
  const prisma = await getPrisma();
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "marketplace_offers" (
      "id" VARCHAR(128) NOT NULL,
      "traveler_id" VARCHAR(128) NOT NULL,
      "traveler_name" VARCHAR(255) NOT NULL,
      "item" VARCHAR(255) NOT NULL,
      "item_cost_cents" INTEGER NOT NULL DEFAULT 0,
      "traveler_fee_cents" INTEGER NOT NULL DEFAULT 0,
      "total_cents" INTEGER NOT NULL,
      "need_by" TIMESTAMPTZ,
      "destination_city" VARCHAR(100),
      "bid_id" VARCHAR(128) NOT NULL DEFAULT '',
      "escrow_id" VARCHAR(128) NOT NULL DEFAULT '',
      "handover_code" VARCHAR(32) NOT NULL DEFAULT '',
      "status" VARCHAR(32) NOT NULL DEFAULT 'offered',
      "shopper_key" VARCHAR(255),
      "shopper_chat_id" VARCHAR(255),
      "notified_shopper" BOOLEAN NOT NULL DEFAULT false,
      "notified_traveler" BOOLEAN NOT NULL DEFAULT false,
      "notified_traveler_funded" BOOLEAN NOT NULL DEFAULT false,
      "next_traveler_id" VARCHAR(128),
      "next_traveler_name" VARCHAR(255),
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "marketplace_offers_pkey" PRIMARY KEY ("id")
    )`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "marketplace_offers_status_created_at_idx" ON "marketplace_offers"("status", "created_at")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "marketplace_offers_traveler_id_status_idx" ON "marketplace_offers"("traveler_id", "status")`,
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "marketplace_trips" (
      "id" UUID NOT NULL,
      "traveler_id" VARCHAR(128) NOT NULL,
      "traveler_name" VARCHAR(255) NOT NULL,
      "origin_city" VARCHAR(100) NOT NULL DEFAULT '',
      "destination_city" VARCHAR(100) NOT NULL,
      "departure_date" DATE NOT NULL,
      "opted_in" BOOLEAN NOT NULL DEFAULT true,
      "status" VARCHAR(32) NOT NULL DEFAULT 'upcoming',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "marketplace_trips_pkey" PRIMARY KEY ("id")
    )`);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_trips_traveler_id_key" ON "marketplace_trips"("traveler_id")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "marketplace_trips_opted_in_destination_city_departure_date_idx" ON "marketplace_trips"("opted_in", "destination_city", "departure_date")`,
  );
  await prisma.marketplaceOffer.updateMany({
    where: {
      status: "offered",
      OR: [{ item: { contains: "AirPods", mode: "insensitive" } }, { item: { contains: "sealed electronics parcel", mode: "insensitive" } }],
    },
    data: { status: "declined" },
  });
  ensured = true;
}

export async function writeOffer(
  input: Omit<StoredOffer, "createdAt"> & { createdAt?: Date },
): Promise<StoredOffer> {
  const createdAt = input.createdAt ?? new Date();
  const row: StoredOffer = {
    ...input,
    itemCostCents: input.itemCostCents ?? 0,
    travelerFeeCents: input.travelerFeeCents ?? 0,
    needBy: input.needBy ?? null,
    destinationCity: input.destinationCity ?? null,
    bidId: input.bidId || input.id,
    escrowId: input.escrowId ?? "",
    handoverCode: input.handoverCode ?? "",
    notifiedShopper: input.notifiedShopper ?? false,
    notifiedTraveler: input.notifiedTraveler ?? false,
    notifiedTravelerFunded: input.notifiedTravelerFunded ?? false,
    createdAt,
  };
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const i = store.offers.findIndex((o) => o.id === row.id);
    if (i >= 0) store.offers[i] = row;
    else store.offers.push(row);
    saveFile(store);
    return row;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const saved = await prisma.marketplaceOffer.upsert({
    where: { id: row.id },
    create: {
      id: row.id,
      travelerId: row.travelerId,
      travelerName: row.travelerName,
      item: row.item,
      itemCostCents: row.itemCostCents,
      travelerFeeCents: row.travelerFeeCents,
      totalCents: row.totalCents,
      needBy: row.needBy,
      destinationCity: row.destinationCity,
      bidId: row.bidId,
      escrowId: row.escrowId,
      handoverCode: row.handoverCode,
      status: row.status,
      shopperKey: row.shopperKey ?? null,
      shopperChatId: row.shopperChatId ?? null,
      notifiedShopper: row.notifiedShopper,
      notifiedTraveler: row.notifiedTraveler,
      notifiedTravelerFunded: row.notifiedTravelerFunded,
      nextTravelerId: row.nextTravelerId ?? null,
      nextTravelerName: row.nextTravelerName ?? null,
    },
    update: {
      travelerId: row.travelerId,
      travelerName: row.travelerName,
      item: row.item,
      itemCostCents: row.itemCostCents,
      travelerFeeCents: row.travelerFeeCents,
      totalCents: row.totalCents,
      needBy: row.needBy,
      destinationCity: row.destinationCity,
      bidId: row.bidId,
      escrowId: row.escrowId,
      handoverCode: row.handoverCode,
      status: row.status,
      shopperKey: row.shopperKey ?? null,
      shopperChatId: row.shopperChatId ?? null,
      notifiedShopper: row.notifiedShopper,
      notifiedTraveler: row.notifiedTraveler,
      notifiedTravelerFunded: row.notifiedTravelerFunded,
      nextTravelerId: row.nextTravelerId ?? null,
      nextTravelerName: row.nextTravelerName ?? null,
    },
  });
  return rowToOffer(saved);
}

export async function updateOffer(id: string, patch: Partial<StoredOffer>): Promise<StoredOffer | null> {
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const i = store.offers.findIndex((o) => o.id === id);
    if (i < 0) return null;
    const next = { ...store.offers[i]!, ...patch, id };
    store.offers[i] = next;
    saveFile(store);
    return next;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const existing = await prisma.marketplaceOffer.findUnique({ where: { id } });
  if (!existing) return null;
  const saved = await prisma.marketplaceOffer.update({
    where: { id },
    data: {
      ...(patch.travelerId != null ? { travelerId: patch.travelerId } : {}),
      ...(patch.travelerName != null ? { travelerName: patch.travelerName } : {}),
      ...(patch.item != null ? { item: patch.item } : {}),
      ...(patch.itemCostCents != null ? { itemCostCents: patch.itemCostCents } : {}),
      ...(patch.travelerFeeCents != null ? { travelerFeeCents: patch.travelerFeeCents } : {}),
      ...(patch.totalCents != null ? { totalCents: patch.totalCents } : {}),
      ...(patch.needBy !== undefined ? { needBy: patch.needBy } : {}),
      ...(patch.destinationCity !== undefined ? { destinationCity: patch.destinationCity } : {}),
      ...(patch.bidId != null ? { bidId: patch.bidId } : {}),
      ...(patch.escrowId != null ? { escrowId: patch.escrowId } : {}),
      ...(patch.handoverCode != null ? { handoverCode: patch.handoverCode } : {}),
      ...(patch.status != null ? { status: patch.status } : {}),
      ...(patch.shopperKey !== undefined ? { shopperKey: patch.shopperKey ?? null } : {}),
      ...(patch.shopperChatId !== undefined ? { shopperChatId: patch.shopperChatId ?? null } : {}),
      ...(patch.notifiedShopper != null ? { notifiedShopper: patch.notifiedShopper } : {}),
      ...(patch.notifiedTraveler != null ? { notifiedTraveler: patch.notifiedTraveler } : {}),
      ...(patch.notifiedTravelerFunded != null ? { notifiedTravelerFunded: patch.notifiedTravelerFunded } : {}),
      ...(patch.nextTravelerId !== undefined ? { nextTravelerId: patch.nextTravelerId ?? null } : {}),
      ...(patch.nextTravelerName !== undefined ? { nextTravelerName: patch.nextTravelerName ?? null } : {}),
    },
  });
  return rowToOffer(saved);
}

export async function getOffer(id: string): Promise<StoredOffer | null> {
  if (!marketplaceConfigured()) {
    return loadFile().offers.find((o) => o.id === id) ?? null;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const row = await prisma.marketplaceOffer.findUnique({ where: { id } });
  return row ? rowToOffer(row) : null;
}

export async function listOpenOffers(): Promise<StoredOffer[]> {
  if (!marketplaceConfigured()) {
    return loadFile()
      .offers.filter((o) => o.status === "offered" && !isStaleDemoItem(o.item))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  await ensurePg();
  const prisma = await getPrisma();
  const rows = await prisma.marketplaceOffer.findMany({
    where: { status: "offered" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(rowToOffer).filter((o) => !isStaleDemoItem(o.item));
}

export async function latestOpenOffer(): Promise<StoredOffer | null> {
  const open = await listOpenOffers();
  return open[0] ?? null;
}

/** Newest in-flight offer (offered/accepted/funded) — used for handover, not inbound listing. */
export async function latestActiveOffer(): Promise<StoredOffer | null> {
  const active = (status: string) => status !== "released" && status !== "declined";
  if (!marketplaceConfigured()) {
    const rows = loadFile().offers.filter((o) => active(o.status) && !isStaleDemoItem(o.item));
    if (!rows.length) return null;
    return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const rows = await prisma.marketplaceOffer.findMany({
    where: { status: { in: ["offered", "accepted", "funded"] } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return rows.map(rowToOffer).find((o) => !isStaleDemoItem(o.item)) ?? null;
}

export async function upsertLiveTrip(input: {
  travelerId: string;
  travelerName: string;
  originCity: string;
  destinationCity: string;
  departureDate: Date;
  optedIn?: boolean;
}): Promise<StoredTrip> {
  const row: StoredTrip = {
    id: randomUUID(),
    travelerId: input.travelerId,
    travelerName: input.travelerName,
    originCity: input.originCity || "",
    destinationCity: input.destinationCity,
    departureDate: input.departureDate,
    optedIn: input.optedIn ?? true,
    status: "upcoming",
  };
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const i = store.trips.findIndex((t) => t.travelerId === row.travelerId);
    if (i >= 0) {
      row.id = store.trips[i]!.id;
      store.trips[i] = row;
    } else store.trips.push(row);
    saveFile(store);
    return row;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const saved = await prisma.marketplaceTrip.upsert({
    where: { travelerId: row.travelerId },
    create: {
      travelerId: row.travelerId,
      travelerName: row.travelerName,
      originCity: row.originCity,
      destinationCity: row.destinationCity,
      departureDate: row.departureDate,
      optedIn: row.optedIn,
      status: "upcoming",
    },
    update: {
      travelerName: row.travelerName,
      originCity: row.originCity,
      destinationCity: row.destinationCity,
      departureDate: row.departureDate,
      optedIn: row.optedIn,
      status: "upcoming",
    },
  });
  return {
    id: saved.id,
    travelerId: saved.travelerId,
    travelerName: saved.travelerName,
    originCity: saved.originCity,
    destinationCity: saved.destinationCity,
    departureDate: saved.departureDate,
    optedIn: saved.optedIn,
    status: saved.status,
  };
}

export async function listLiveTrips(destinationCity: string): Promise<StoredTrip[]> {
  if (!marketplaceConfigured()) {
    return loadFile().trips.filter(
      (t) =>
        t.optedIn &&
        t.status === "upcoming" &&
        t.destinationCity.toLowerCase() === destinationCity.toLowerCase(),
    );
  }
  await ensurePg();
  const prisma = await getPrisma();
  const rows = await prisma.marketplaceTrip.findMany({
    where: {
      optedIn: true,
      status: "upcoming",
      destinationCity: { equals: destinationCity, mode: "insensitive" },
    },
    orderBy: { departureDate: "asc" },
    take: 20,
  });
  return rows.map((t) => ({
    id: t.id,
    travelerId: t.travelerId,
    travelerName: t.travelerName,
    originCity: t.originCity,
    destinationCity: t.destinationCity,
    departureDate: t.departureDate,
    optedIn: t.optedIn,
    status: t.status,
  }));
}

export function initMarketplaceFile(): void {
  saveFile({ offers: [], trips: [] });
}
