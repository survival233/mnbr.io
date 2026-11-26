/**
 * Persistent webhook idempotency (Postgres). Survives restarts and is shared
 * across instances, unlike an in-memory set. Deploy-safe: if DATABASE_URL is
 * unset or the webhook_events table has not been migrated yet, this THROWS so
 * the caller can fall back to its in-memory dedupe — it never silently accepts
 * a duplicate, and a plain duplicate returns false rather than throwing.
 */
import { randomUUID } from "node:crypto";

type Prisma = import("@prisma/client").PrismaClient;

async function getPrisma(): Promise<Prisma> {
  const { prisma } = await import("./client");
  return prisma;
}

function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

let sincePrune = 0;

/**
 * Record a webhook event. Returns true if it is NEW (process it), false if it is
 * a duplicate. Throws when the store is unavailable (no DATABASE_URL, or the
 * table is missing) so the caller can fall back to in-memory dedupe.
 */
export async function rememberWebhookEvent(provider: string, eventId: string): Promise<boolean> {
  if (!eventId) return true;
  if (!dbConfigured()) throw new Error("webhook idempotency: no DATABASE_URL");
  const prisma = await getPrisma();
  try {
    await prisma.processedWebhook.create({ data: { id: randomUUID(), provider, eventId } });
  } catch (e: any) {
    if (e?.code === "P2002") return false; // unique(provider, eventId) → duplicate
    throw e; // e.g. P2021 (table missing) → caller falls back to in-memory
  }
  // Opportunistically bound table growth.
  if (++sincePrune >= 200) {
    sincePrune = 0;
    const cutoff = new Date(Date.now() - 7 * 24 * 3600_000);
    void prisma.processedWebhook.deleteMany({ where: { receivedAt: { lt: cutoff } } }).catch(() => {});
  }
  return true;
}
