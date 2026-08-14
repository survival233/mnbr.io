/**
 * Demo-only shared carry file. Chat logs are not source of truth.
 * Path: DEMO_MARKETPLACE_PATH (set by npm run demo).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type CarryStatus = "offered" | "accepted" | "declined" | "funded" | "released";

export type Carry = {
  id: string;
  travelerId: string;
  travelerName: string;
  item: string;
  bidId: string;
  escrowId: string;
  handoverCode: string;
  totalCents: number;
  status: CarryStatus;
  createdAt: number;
  shopperKey?: string;
  shopperChatId?: string | null;
  notifiedShopper?: boolean;
  notifiedTraveler?: boolean;
  notifiedTravelerFunded?: boolean;
  nextTravelerId?: string;
  nextTravelerName?: string;
};

type Store = { carries: Carry[] };

function defaultPath(): string {
  return fileURLToPath(new URL("../.demo-marketplace.json", import.meta.url));
}

export function marketplacePath(): string {
  return process.env.DEMO_MARKETPLACE_PATH?.trim() || defaultPath();
}

function load(): Store {
  try {
    const raw = readFileSync(marketplacePath(), "utf8");
    const parsed = JSON.parse(raw) as Store;
    return { carries: Array.isArray(parsed.carries) ? parsed.carries : [] };
  } catch {
    return { carries: [] };
  }
}

function save(store: Store): void {
  const p = marketplacePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2));
}

export function initMarketplace(): void {
  save({ carries: [] });
}

export function writeCarry(input: Omit<Carry, "createdAt"> & { createdAt?: number }): Carry {
  const store = load();
  const carry: Carry = { ...input, createdAt: input.createdAt ?? Date.now() };
  const i = store.carries.findIndex((c) => c.id === carry.id);
  if (i >= 0) store.carries[i] = carry;
  else store.carries.push(carry);
  save(store);
  return carry;
}

export function updateCarry(id: string, patch: Partial<Carry>): Carry | null {
  const store = load();
  const i = store.carries.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const next = { ...store.carries[i]!, ...patch, id };
  store.carries[i] = next;
  save(store);
  return next;
}

export function findCarry(id: string): Carry | null {
  return load().carries.find((c) => c.id === id) ?? null;
}

/** Newest carry still in flight (not released or declined). */
export function latestActiveCarry(): Carry | null {
  const active = load().carries.filter((c) => c.status !== "released" && c.status !== "declined");
  if (!active.length) return null;
  return active.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}
