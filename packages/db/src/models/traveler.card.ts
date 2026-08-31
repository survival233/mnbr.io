/**
 * Traveler default card (AgentCard vault). Last4/brand only — no PAN.
 * Shopper identities use the same store so both agents can add a test card.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type StoredCard = {
  identity: string;
  agentcardUserId?: string | null;
  last4?: string | null;
  brand?: string | null;
  isDefault: boolean;
  updatedAt: Date;
};

type Prisma = import("@prisma/client").PrismaClient;

async function getPrisma(): Promise<Prisma> {
  const { prisma } = await import("../client");
  return prisma;
}

function pg(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function filePath(): string {
  return process.env.AGENTCARD_CARDS_PATH?.trim() || ".agentcard-cards.json";
}

function loadFile(): StoredCard[] {
  try {
    const raw = JSON.parse(readFileSync(filePath(), "utf8")) as { cards?: StoredCard[] };
    return (raw.cards ?? []).map((c) => ({ ...c, updatedAt: new Date(c.updatedAt) }));
  } catch {
    return [];
  }
}

function saveFile(cards: StoredCard[]): void {
  const p = filePath();
  mkdirSync(dirname(p) === "." ? "." : dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ cards }, null, 2));
}

let ensured = false;

async function ensurePg(): Promise<void> {
  if (ensured) return;
  const prisma = await getPrisma();
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "connected_cards" (
      "identity" VARCHAR(255) NOT NULL,
      "agentcard_user_id" VARCHAR(128),
      "last4" VARCHAR(8),
      "brand" VARCHAR(64),
      "is_default" BOOLEAN NOT NULL DEFAULT true,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "connected_cards_pkey" PRIMARY KEY ("identity")
    )`);
  ensured = true;
}

export async function getConnectedCard(identity: string): Promise<StoredCard | null> {
  const key = identity.trim();
  if (!key) return null;
  if (!pg()) {
    return loadFile().find((c) => c.identity === key) ?? null;
  }
  await ensurePg();
  const prisma = await getPrisma();
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      identity: string;
      agentcard_user_id: string | null;
      last4: string | null;
      brand: string | null;
      is_default: boolean;
      updated_at: Date;
    }>
  >(`SELECT identity, agentcard_user_id, last4, brand, is_default, updated_at FROM connected_cards WHERE identity = $1`, key);
  const r = rows[0];
  if (!r) return null;
  return {
    identity: r.identity,
    agentcardUserId: r.agentcard_user_id,
    last4: r.last4,
    brand: r.brand,
    isDefault: r.is_default,
    updatedAt: r.updated_at,
  };
}

export async function setConnectedCard(input: {
  identity: string;
  agentcardUserId?: string | null;
  last4?: string | null;
  brand?: string | null;
  isDefault?: boolean;
}): Promise<StoredCard> {
  const row: StoredCard = {
    identity: input.identity.trim(),
    agentcardUserId: input.agentcardUserId ?? null,
    last4: input.last4 ?? null,
    brand: input.brand ?? null,
    isDefault: input.isDefault ?? true,
    updatedAt: new Date(),
  };
  if (!pg()) {
    const cards = loadFile().filter((c) => c.identity !== row.identity);
    cards.push(row);
    saveFile(cards);
    return row;
  }
  await ensurePg();
  const prisma = await getPrisma();
  await prisma.$executeRawUnsafe(
    `INSERT INTO connected_cards (identity, agentcard_user_id, last4, brand, is_default, updated_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (identity) DO UPDATE SET
       agentcard_user_id = EXCLUDED.agentcard_user_id,
       last4 = EXCLUDED.last4,
       brand = EXCLUDED.brand,
       is_default = EXCLUDED.is_default,
       updated_at = CURRENT_TIMESTAMP`,
    row.identity,
    row.agentcardUserId,
    row.last4,
    row.brand,
    row.isDefault,
  );
  return row;
}

/** Traveler's default card — already on file after connected_card.updated. */
export async function getTravelerCard(identity: string): Promise<StoredCard | null> {
  const card = await getConnectedCard(identity);
  if (!card) return null;
  return card.isDefault ? card : null;
}

export async function setTravelerCard(input: {
  identity: string;
  agentcardUserId?: string | null;
  last4?: string | null;
  brand?: string | null;
}): Promise<StoredCard> {
  return setConnectedCard({ ...input, isDefault: true });
}
