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

export type OfferStatus =
  | "offered"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired"
  | "funded"
  | "released";

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
  source?: string;
  externalEventId?: string;
  optedInAt?: Date | null;
  departAt?: Date | null;
  arriveAt?: Date | null;
  timezone?: string | null;
  retentionUntil?: Date | null;
  confidence?: number;
};

export type StoredCalendarLink = {
  travelerId: string;
  provider: string;
  status: "connected" | "disconnected";
  scopes: string;
  tokenCipher: string | null;
  refreshCipher: string | null;
  expiresAt: Date | null;
  connectedAt: Date | null;
  revokedAt: Date | null;
};

type FileStore = {
  offers: StoredOffer[];
  trips: StoredTrip[];
  calendarLinks: StoredCalendarLink[];
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
    const calendarLinks = Array.isArray((raw as { calendarLinks?: StoredCalendarLink[] }).calendarLinks)
      ? (raw as { calendarLinks: StoredCalendarLink[] }).calendarLinks.map(hydrateLink)
      : [];
    return { offers, trips, calendarLinks };
  } catch {
    return { offers: [], trips: [], calendarLinks: [] };
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
        calendarLinks: store.calendarLinks,
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
  return {
    ...t,
    departureDate: new Date(t.departureDate),
    externalEventId: t.externalEventId ?? "",
    source: t.source ?? (t.externalEventId ? "calendar" : "manual"),
    optedInAt: t.optedInAt ? new Date(t.optedInAt) : null,
    departAt: t.departAt ? new Date(t.departAt) : null,
    arriveAt: t.arriveAt ? new Date(t.arriveAt) : null,
    retentionUntil: t.retentionUntil ? new Date(t.retentionUntil) : null,
  };
}

function hydrateLink(l: StoredCalendarLink): StoredCalendarLink {
  return {
    ...l,
    expiresAt: l.expiresAt ? new Date(l.expiresAt) : null,
    connectedAt: l.connectedAt ? new Date(l.connectedAt) : null,
    revokedAt: l.revokedAt ? new Date(l.revokedAt) : null,
  };
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
  // #region agent log
  try {
    const raw = process.env.DATABASE_URL ?? "";
    const u = raw ? new URL(raw) : null;
    fetch("http://127.0.0.1:7854/ingest/a231508e-92f8-412b-a181-535e3ce153db", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "38c5c9" },
      body: JSON.stringify({
        sessionId: "38c5c9",
        runId: "pre-fix",
        hypothesisId: "D",
        location: "marketplace.ts:ensurePg",
        message: "connecting",
        data: {
          hasUrl: Boolean(raw),
          host: u?.hostname ?? "",
          port: u?.port ?? "",
          protocol: u?.protocol ?? "",
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
  // #endregion
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

/** Funded matching requests only — never tease Shop & Deliver on an unfunded offer. */
export async function listFundedOffers(): Promise<StoredOffer[]> {
  if (!marketplaceConfigured()) {
    return loadFile()
      .offers.filter((o) => o.status === "funded" && !isStaleDemoItem(o.item))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  await ensurePg();
  const prisma = await getPrisma();
  const rows = await prisma.marketplaceOffer.findMany({
    where: { status: "funded" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(rowToOffer).filter((o) => !isStaleDemoItem(o.item));
}

export async function latestOpenOffer(): Promise<StoredOffer | null> {
  const open = await listOpenOffers();
  return open[0] ?? null;
}

export async function getOpenOfferForTraveler(travelerId: string): Promise<StoredOffer | null> {
  const open = await listOpenOffers();
  return open.find((o) => o.travelerId === travelerId) ?? null;
}

function isInFlight(status: string): boolean {
  return status === "offered" || status === "accepted" || status === "funded";
}

/** Newest in-flight offer (offered/accepted/funded) — used for handover, not inbound listing. */
export async function latestActiveOffer(): Promise<StoredOffer | null> {
  if (!marketplaceConfigured()) {
    const rows = loadFile().offers.filter((o) => isInFlight(o.status) && !isStaleDemoItem(o.item));
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

export async function getActiveOfferForTraveler(travelerId: string): Promise<StoredOffer | null> {
  if (!marketplaceConfigured()) {
    const rows = loadFile().offers.filter(
      (o) => o.travelerId === travelerId && isInFlight(o.status) && !isStaleDemoItem(o.item),
    );
    if (!rows.length) return null;
    return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const rows = await prisma.marketplaceOffer.findMany({
    where: { travelerId, status: { in: ["offered", "accepted", "funded"] } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return rows.map(rowToOffer).find((o) => !isStaleDemoItem(o.item)) ?? null;
}

/** Accept only if still offered — drops a late yes after cancel / timeout / another accept. */
export async function acceptOfferIfOpen(id: string): Promise<StoredOffer | null> {
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const i = store.offers.findIndex((o) => o.id === id);
    if (i < 0 || store.offers[i]!.status !== "offered") return null;
    store.offers[i] = { ...store.offers[i]!, status: "accepted", notifiedShopper: false };
    saveFile(store);
    return store.offers[i]!;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const res = await prisma.marketplaceOffer.updateMany({
    where: { id, status: "offered" },
    data: { status: "accepted", notifiedShopper: false },
  });
  if (res.count === 0) return null;
  return getOffer(id);
}

/** Close leftover offered/accepted rows that never funded (demo leftovers). */
export async function expireStaleMarketplaceOffers(maxAgeMs = 72 * 3600_000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  if (!marketplaceConfigured()) {
    const store = loadFile();
    let n = 0;
    for (const o of store.offers) {
      if ((o.status === "offered" || o.status === "accepted") && o.createdAt < cutoff) {
        o.status = "declined";
        n += 1;
      }
    }
    if (n) saveFile(store);
    return n;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const res = await prisma.marketplaceOffer.updateMany({
    where: { status: { in: ["offered", "accepted"] }, updatedAt: { lt: cutoff } },
    data: { status: "declined" },
  });
  return res.count;
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
    optedIn: input.optedIn ?? false,
    status: "upcoming",
  };
  const manual: StoredTrip = { ...row, source: "manual", externalEventId: "" };
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const i = store.trips.findIndex(
      (t) => t.travelerId === manual.travelerId && (t.externalEventId ?? "") === "" && (t.source ?? "manual") !== "calendar",
    );
    if (i >= 0) {
      manual.id = store.trips[i]!.id;
      store.trips[i] = { ...store.trips[i]!, ...manual };
    } else store.trips.push(manual);
    saveFile(store);
    return manual;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const existing = await prisma.marketplaceTrip.findFirst({
    where: { travelerId: manual.travelerId, externalEventId: "" },
  });
  const saved = existing
    ? await prisma.marketplaceTrip.update({
        where: { id: existing.id },
        data: {
          travelerName: manual.travelerName,
          originCity: manual.originCity,
          destinationCity: manual.destinationCity,
          departureDate: manual.departureDate,
          optedIn: manual.optedIn,
          status: "upcoming",
          source: "manual",
        },
      })
    : await prisma.marketplaceTrip.create({
        data: {
          travelerId: manual.travelerId,
          travelerName: manual.travelerName,
          originCity: manual.originCity,
          destinationCity: manual.destinationCity,
          departureDate: manual.departureDate,
          optedIn: manual.optedIn,
          status: "upcoming",
          source: "manual",
          externalEventId: "",
        },
      });
  return tripFromRow(saved);
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

/** Upcoming opted-in trips, any destination. Callers filter by metro. */
export async function listUpcomingTrips(): Promise<StoredTrip[]> {
  const now = new Date();
  if (!marketplaceConfigured()) {
    return loadFile().trips.filter(
      (t) => t.optedIn && t.status === "upcoming" && t.departureDate.getTime() > now.getTime(),
    );
  }
  await ensurePg();
  const prisma = await getPrisma();
  const rows = await prisma.marketplaceTrip.findMany({
    where: {
      optedIn: true,
      status: "upcoming",
      departureDate: { gt: now },
    },
    orderBy: { departureDate: "asc" },
    take: 40,
  });
  return rows.map((t) => tripFromRow(t));
}

function tripFromRow(t: {
  id: string;
  travelerId: string;
  travelerName: string;
  originCity: string;
  destinationCity: string;
  departureDate: Date;
  optedIn: boolean;
  status: string;
  source?: string;
  externalEventId?: string;
  optedInAt?: Date | null;
  departAt?: Date | null;
  arriveAt?: Date | null;
  timezone?: string | null;
  retentionUntil?: Date | null;
  confidence?: number;
}): StoredTrip {
  return {
    id: t.id,
    travelerId: t.travelerId,
    travelerName: t.travelerName,
    originCity: t.originCity,
    destinationCity: t.destinationCity,
    departureDate: t.departureDate,
    optedIn: t.optedIn,
    status: t.status,
    source: t.source ?? "manual",
    externalEventId: t.externalEventId ?? "",
    optedInAt: t.optedInAt ?? null,
    departAt: t.departAt ?? null,
    arriveAt: t.arriveAt ?? null,
    timezone: t.timezone ?? null,
    retentionUntil: t.retentionUntil ?? null,
    confidence: t.confidence ?? 1,
  };
}

export async function listTripsForTraveler(travelerId: string): Promise<StoredTrip[]> {
  if (!marketplaceConfigured()) {
    return loadFile().trips.filter((t) => t.travelerId === travelerId);
  }
  await ensurePg();
  const prisma = await getPrisma();
  const rows = await prisma.marketplaceTrip.findMany({
    where: { travelerId },
    orderBy: { departureDate: "asc" },
  });
  return rows.map((t) => tripFromRow(t));
}

/** Idempotent calendar proposal. Does not clear an existing opt-in. */
export async function upsertCalendarTrip(input: {
  travelerId: string;
  travelerName: string;
  externalEventId: string;
  originCity: string;
  destinationCity: string;
  departureDate: Date;
  departAt: Date;
  arriveAt: Date | null;
  timezone: string;
  confidence: number;
  retentionUntil: Date;
}): Promise<StoredTrip> {
  if (!input.externalEventId.trim()) throw new Error("calendar trip needs an external event id");
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const i = store.trips.findIndex(
      (t) => t.travelerId === input.travelerId && t.externalEventId === input.externalEventId,
    );
    const prev = i >= 0 ? store.trips[i]! : null;
    const row: StoredTrip = {
      id: prev?.id ?? randomUUID(),
      travelerId: input.travelerId,
      travelerName: input.travelerName,
      originCity: input.originCity,
      destinationCity: input.destinationCity,
      departureDate: input.departureDate,
      departAt: input.departAt,
      arriveAt: input.arriveAt,
      timezone: input.timezone,
      confidence: input.confidence,
      retentionUntil: input.retentionUntil,
      source: "calendar",
      externalEventId: input.externalEventId,
      optedIn: prev?.optedIn ?? false,
      optedInAt: prev?.optedInAt ?? null,
      status: prev?.optedIn ? prev.status : "proposed",
    };
    if (i >= 0) store.trips[i] = row;
    else store.trips.push(row);
    saveFile(store);
    return row;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const existing = await prisma.marketplaceTrip.findUnique({
    where: {
      travelerId_externalEventId: {
        travelerId: input.travelerId,
        externalEventId: input.externalEventId,
      },
    },
  });
  const saved = existing
    ? await prisma.marketplaceTrip.update({
        where: { id: existing.id },
        data: {
          originCity: input.originCity,
          destinationCity: input.destinationCity,
          departureDate: input.departureDate,
          departAt: input.departAt,
          arriveAt: input.arriveAt,
          timezone: input.timezone,
          confidence: input.confidence,
          retentionUntil: existing.optedIn ? existing.retentionUntil : input.retentionUntil,
          source: "calendar",
        },
      })
    : await prisma.marketplaceTrip.create({
        data: {
          travelerId: input.travelerId,
          travelerName: input.travelerName,
          originCity: input.originCity,
          destinationCity: input.destinationCity,
          departureDate: input.departureDate,
          departAt: input.departAt,
          arriveAt: input.arriveAt,
          timezone: input.timezone,
          confidence: input.confidence,
          retentionUntil: input.retentionUntil,
          source: "calendar",
          externalEventId: input.externalEventId,
          optedIn: false,
          status: "proposed",
        },
      });
  return tripFromRow(saved);
}

export async function setCalendarTripChoice(input: {
  travelerId: string;
  externalEventId: string;
  optedIn: boolean;
  optedInAt: Date;
  retentionUntil: Date;
}): Promise<StoredTrip | null> {
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const i = store.trips.findIndex(
      (t) => t.travelerId === input.travelerId && t.externalEventId === input.externalEventId,
    );
    if (i < 0) return null;
    const prev = store.trips[i]!;
    store.trips[i] = {
      ...prev,
      optedIn: input.optedIn,
      optedInAt: input.optedInAt,
      status: input.optedIn ? "upcoming" : "declined",
      retentionUntil: input.retentionUntil,
    };
    saveFile(store);
    return store.trips[i]!;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const existing = await prisma.marketplaceTrip.findUnique({
    where: {
      travelerId_externalEventId: {
        travelerId: input.travelerId,
        externalEventId: input.externalEventId,
      },
    },
  });
  if (!existing) return null;
  const saved = await prisma.marketplaceTrip.update({
    where: { id: existing.id },
    data: {
      optedIn: input.optedIn,
      optedInAt: input.optedInAt,
      status: input.optedIn ? "upcoming" : "declined",
      retentionUntil: input.retentionUntil,
    },
  });
  return tripFromRow(saved);
}

export async function getCalendarLink(travelerId: string): Promise<StoredCalendarLink | null> {
  if (!marketplaceConfigured()) {
    return loadFile().calendarLinks.find((l) => l.travelerId === travelerId) ?? null;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const row = await prisma.marketplaceCalendarLink.findUnique({ where: { travelerId } });
  if (!row) return null;
  return {
    travelerId: row.travelerId,
    provider: row.provider,
    status: row.status === "connected" ? "connected" : "disconnected",
    scopes: row.scopes,
    tokenCipher: row.tokenCipher,
    refreshCipher: row.refreshCipher,
    expiresAt: row.expiresAt,
    connectedAt: row.connectedAt,
    revokedAt: row.revokedAt,
  };
}

export async function saveCalendarLink(link: StoredCalendarLink): Promise<void> {
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const i = store.calendarLinks.findIndex((l) => l.travelerId === link.travelerId);
    if (i >= 0) store.calendarLinks[i] = link;
    else store.calendarLinks.push(link);
    saveFile(store);
    return;
  }
  await ensurePg();
  const prisma = await getPrisma();
  await prisma.marketplaceCalendarLink.upsert({
    where: { travelerId: link.travelerId },
    create: { ...link },
    update: {
      provider: link.provider,
      status: link.status,
      scopes: link.scopes,
      tokenCipher: link.tokenCipher,
      refreshCipher: link.refreshCipher,
      expiresAt: link.expiresAt,
      connectedAt: link.connectedAt,
      revokedAt: link.revokedAt,
    },
  });
}

/** Disconnect: drop proposed and declined calendar trips; keep opted-in upcoming rows. */
export async function disconnectCalendarSource(travelerId: string): Promise<{ kept: number; removed: number }> {
  const drop = (t: StoredTrip) =>
    t.travelerId === travelerId &&
    t.source === "calendar" &&
    !(t.optedIn && t.status === "upcoming");
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const before = store.trips.length;
    const kept = store.trips.filter((t) => t.travelerId === travelerId && t.source === "calendar" && t.optedIn && t.status === "upcoming").length;
    store.trips = store.trips.filter((t) => !drop(t));
    const link = store.calendarLinks.find((l) => l.travelerId === travelerId);
    if (link) {
      link.status = "disconnected";
      link.tokenCipher = null;
      link.refreshCipher = null;
      link.revokedAt = new Date();
    }
    saveFile(store);
    return { kept, removed: before - store.trips.length };
  }
  await ensurePg();
  const prisma = await getPrisma();
  const kept = await prisma.marketplaceTrip.count({
    where: { travelerId, source: "calendar", optedIn: true, status: "upcoming" },
  });
  const removed = await prisma.marketplaceTrip.deleteMany({
    where: {
      travelerId,
      source: "calendar",
      NOT: { optedIn: true, status: "upcoming" },
    },
  });
  await prisma.marketplaceCalendarLink.updateMany({
    where: { travelerId },
    data: { status: "disconnected", tokenCipher: null, refreshCipher: null, revokedAt: new Date() },
  });
  return { kept, removed: removed.count };
}

/**
 * Erasure deletes derived calendar trips and the link.
 * An active claim (accepted or funded) keeps opted-in trip rows for the snapshot.
 */
export async function eraseCalendarSource(
  travelerId: string,
  opts: { activeClaim?: boolean } = {},
): Promise<{ deletedTrips: number; keptForClaim: number }> {
  if (!marketplaceConfigured()) {
    const store = loadFile();
    let keptForClaim = 0;
    const before = store.trips.length;
    store.trips = store.trips.filter((t) => {
      if (t.travelerId !== travelerId || t.source !== "calendar") return true;
      if (opts.activeClaim && t.optedIn && t.status === "upcoming") {
        keptForClaim += 1;
        return true;
      }
      return false;
    });
    store.calendarLinks = store.calendarLinks.filter((l) => l.travelerId !== travelerId);
    saveFile(store);
    return { deletedTrips: before - store.trips.length, keptForClaim };
  }
  await ensurePg();
  const prisma = await getPrisma();
  let keptForClaim = 0;
  if (opts.activeClaim) {
    keptForClaim = await prisma.marketplaceTrip.count({
      where: { travelerId, source: "calendar", optedIn: true, status: "upcoming" },
    });
  }
  const removed = await prisma.marketplaceTrip.deleteMany({
    where: opts.activeClaim
      ? { travelerId, source: "calendar", NOT: { optedIn: true, status: "upcoming" } }
      : { travelerId, source: "calendar" },
  });
  await prisma.marketplaceCalendarLink.deleteMany({ where: { travelerId } });
  return { deletedTrips: removed.count, keptForClaim };
}

export async function deleteCalendarLink(travelerId: string): Promise<void> {
  if (!marketplaceConfigured()) {
    const store = loadFile();
    store.calendarLinks = store.calendarLinks.filter((l) => l.travelerId !== travelerId);
    saveFile(store);
    return;
  }
  await ensurePg();
  const prisma = await getPrisma();
  await prisma.marketplaceCalendarLink.deleteMany({ where: { travelerId } });
}

export async function deleteCalendarTrips(travelerId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  if (!marketplaceConfigured()) {
    const store = loadFile();
    const before = store.trips.length;
    const drop = new Set(ids);
    store.trips = store.trips.filter((t) => !(t.travelerId === travelerId && drop.has(t.id)));
    saveFile(store);
    return before - store.trips.length;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const res = await prisma.marketplaceTrip.deleteMany({ where: { travelerId, id: { in: ids } } });
  return res.count;
}

export function initMarketplaceFile(): void {
  saveFile({ offers: [], trips: [], calendarLinks: [] });
}
