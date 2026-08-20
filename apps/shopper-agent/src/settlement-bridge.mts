/**
 * In-process settlement bridge for Shopper agent.
 * Requires SETTLEMENT_ENABLED=1 and apps/api/.env (RPC, escrow, attestor, operator, DB).
 *
 * Flow: ensure shopper + travelers → item → bid → accept → top-up USDC → fund
 * → arrive → handover code → (on DONE) confirm + beta immediate release.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { suggestedTravelerFeeCents, computeFees, endOfLocalDay } from "@manebra/shared";
import { centsToUsdc } from "@manebra/settlement";
import type { ProductListing } from "@manebra/catalog";
import { SEED_TRAVELERS } from "./traveler-seeds.mts";
import { digits } from "./session.mts";

export function settlementEnabled(): boolean {
  return process.env.SETTLEMENT_ENABLED === "1" || process.env.SETTLEMENT_ENABLED === "true";
}

function isProdRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.RENDER === "true" ||
    Boolean(process.env.RENDER_SERVICE_ID)
  );
}

function loadApiEnv() {
  for (const rel of ["../../api/.env", "../.env"]) {
    try {
      const p = new URL(rel, import.meta.url);
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
    } catch {
      /* optional */
    }
  }

  const prod = isProdRuntime();
  if (!process.env.DATABASE_URL) {
    if (prod) {
      throw new Error(
        "DATABASE_URL is required when SETTLEMENT_ENABLED=1 (set it in the host env, not a localhost default)",
      );
    }
    // Local-only fallback — generic role, no machine-specific username
    process.env.DATABASE_URL = "postgresql://postgres@127.0.0.1:5432/manebra";
  }
  process.env.DIRECT_URL ??= process.env.DATABASE_URL;
  process.env.CHAIN_ENV ??= "testnet";

  if (prod) {
    for (const key of ["LOCAL_WALLET_SEED", "HANDOVER_CODE_SECRET"] as const) {
      if (!process.env[key]) {
        throw new Error(`${key} is required when SETTLEMENT_ENABLED=1 in production`);
      }
    }
  } else {
    process.env.LOCAL_WALLET_SEED ??= "manebra-local-dev-seed";
    process.env.HANDOVER_CODE_SECRET ??= "dev-handover-code-secret";
    process.env.INNGEST_EVENT_KEY ??= "local";
    process.env.INNGEST_BASE_URL ??= "http://127.0.0.1:8299";
    process.env.INNGEST_DEV ??= "1";
  }

  if (!process.env.INNGEST_BASE_URL) {
    throw new Error("INNGEST_BASE_URL is required when SETTLEMENT_ENABLED=1");
  }
}

let stubReady: Promise<void> | null = null;
function ensureInngestStub() {
  if (stubReady) return stubReady;
  stubReady = new Promise((resolve) => {
    const port = Number(new URL(process.env.INNGEST_BASE_URL!).port || 8299);
    const sink = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ids: [randomUUID()], status: 200 }));
      });
    });
    sink.listen(port, "127.0.0.1", () => resolve());
    sink.on("error", () => resolve()); // port in use is fine
  });
  return stubReady;
}

async function giveUsdc(to: `0x${string}`, amount: bigint) {
  const { createPublicClient, createWalletClient, http, getAddress } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { baseSepolia } = await import("viem/chains");
  const usdc = getAddress(process.env.USDC_ADDRESS!);
  const funderKey = (process.env.USDC_FUNDER_PRIVATE_KEY ??
    process.env.MINTER_PRIVATE_KEY ??
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
  const account = privateKeyToAccount(funderKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(process.env.RPC_URL) });
  const erc20Abi = [
    { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
    { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  ] as const;
  const fn = process.env.SMOKE_USDC_MODE === "transfer" ? "transfer" : "mint";
  const hash = await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: fn, args: [to, amount] });
  await publicClient.waitForTransactionReceipt({ hash });
}

export type FundOrderInput = {
  phone: string;
  travelerId: string;
  selected: ProductListing;
  deliveryCity: string;
  deadline: Date;
  shoppingCity: string;
  maxFeeCents: number;
  category?: string;
};

export type FundOrderResult = {
  bidId: string;
  escrowId: string;
  totalCents: number;
  fees: ReturnType<typeof computeFees>;
  handoverCode: string;
  travelerId: string;
  fundTxHash: string;
};

async function ensureTravelers(prisma: typeof import("@manebra/db").prisma, destinationCity: string) {
  const day = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    d.setUTCHours(12, 0, 0, 0);
    return d;
  };
  for (const t of SEED_TRAVELERS) {
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
        isVerified: true,
        trustScore: t.trustScore,
        totalDeliveries: t.totalDeliveries,
        accountStatus: "active",
      },
    });
    const trip = await prisma.travelerTrip.findFirst({
      where: { travelerId: t.id, status: "upcoming", destinationCity },
    });
    if (!trip) {
      await prisma.travelerTrip.create({
        data: {
          travelerId: t.id,
          direction: "us_to_gh",
          departureCity: "New York",
          destinationCity,
          departureDate: day(t.daysUntilDep),
          luggageCapacityKg: 23,
          status: "upcoming",
          source: "manual",
        },
      });
    } else {
      await prisma.travelerTrip.update({
        where: { id: trip.id },
        data: { departureDate: day(t.daysUntilDep) },
      });
    }
  }
}

async function ensureShopper(prisma: typeof import("@manebra/db").prisma, phone: string) {
  const email = `linq+${digits(phone)}@manebra.test`;
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { phone }] } });
  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: { phone, isVerified: true, accountStatus: "active", userRole: "both" },
    });
  }
  return prisma.user.create({
    data: {
      id: randomUUID(),
      email,
      phone,
      fullName: `Linq Shopper ${digits(phone).slice(-4)}`,
      userRole: "both",
      isVerified: true,
      trustScore: 150,
      totalDeliveries: 5,
      accountStatus: "active",
    },
  });
}

/** Open + fund escrow and issue handover code. */
export async function fundEscrowOrder(input: FundOrderInput): Promise<FundOrderResult> {
  if (!settlementEnabled()) throw new Error("SETTLEMENT_ENABLED is not set");
  loadApiEnv();
  for (const k of ["HANDOVER_ESCROW_ADDRESS", "USDC_ADDRESS", "ATTESTOR_PRIVATE_KEY", "RPC_URL"]) {
    if (!process.env[k]) throw new Error(`${k} missing — wire apps/api/.env`);
  }
  await ensureInngestStub();

  const { prisma } = await import("@manebra/db");
    const { appRouter } = await import("../../api/src/server/routers/_app.js");

  await ensureTravelers(prisma, input.deliveryCity);
  const shopper = await ensureShopper(prisma, input.phone);
  const traveler = SEED_TRAVELERS.find((t) => t.id === input.travelerId);
  if (!traveler) throw new Error(`Unknown traveler ${input.travelerId}`);

  const trip = await prisma.travelerTrip.findFirst({
    where: { travelerId: traveler.id, status: "upcoming", destinationCity: input.deliveryCity },
    orderBy: { departureDate: "asc" },
  });
  if (!trip) throw new Error(`No upcoming trip to ${input.deliveryCity} for ${traveler.name}`);

  const category = (["electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable"].includes(
    input.category ?? "",
  )
    ? input.category
    : "electronics") as
    | "electronics"
    | "clothing_shoes"
    | "cosmetics_sealed"
    | "books_media"
    | "food_sealed_nonperishable";

  const item = await prisma.itemRequest.create({
    data: {
      shopperId: shopper.id,
      itemName: input.selected.productTitle.slice(0, 200),
      itemCostCents: input.selected.priceCents,
      itemUrl: input.selected.productUrl ?? undefined,
      itemImageUrl: input.selected.imageUrl ?? undefined,
      category,
      direction: "us_to_gh",
      destinationCity: input.deliveryCity,
      shoppingCity: input.shoppingCity,
      retailerName: input.selected.storeName,
      quantity: 1,
      reviewStatus: "auto_approved",
      status: "open",
      expiresAt: endOfLocalDay(input.deadline),
    },
  });

  const fee = Math.min(suggestedTravelerFeeCents(input.selected.priceCents), input.maxFeeCents);
  const fees = computeFees(input.selected.priceCents, fee);
  const caller = (userId: string) => appRouter.createCaller({ prisma, userId });

  const bid = await caller(traveler.id).bids.create({
    itemRequestId: item.id,
    tripId: trip.id,
    travelerFeeCents: fee,
    promisedDeliveryDate: endOfLocalDay(input.deadline),
  });

  const accepted = await caller(shopper.id).bids.accept({ bidId: bid.id });
  const shopperRow = await prisma.user.findUniqueOrThrow({ where: { id: shopper.id } });
  if (!shopperRow.walletAddress) throw new Error("Shopper wallet missing after accept");
  await giveUsdc(shopperRow.walletAddress as `0x${string}`, centsToUsdc(bid.totalCents));
  const funded = await caller(shopper.id).settlement.fundBid({ bidId: bid.id });

  await prisma.bid.update({
    where: { id: bid.id },
    data: {
      status: "arrived",
      purchasedAt: new Date(),
      inTransitAt: new Date(),
      arrivedAt: new Date(),
    },
  });

  const { code } = await caller(shopper.id).handover.generateCode({ bidId: bid.id });

  return {
    bidId: bid.id,
    escrowId: accepted.escrowId,
    totalCents: bid.totalCents,
    fees,
    handoverCode: code,
    travelerId: traveler.id,
    fundTxHash: funded.txHash,
  };
}

/** Traveler confirms code + beta immediate release (skips 48h window). */
export async function completeHandoverAndRelease(args: {
  bidId: string;
  travelerId: string;
  code: string;
}): Promise<{ released: boolean; settleTxHash?: string }> {
  loadApiEnv();
  await ensureInngestStub();
  const { prisma } = await import("@manebra/db");
    const { appRouter } = await import("../../api/src/server/routers/_app.js");
  const { onReleaseScheduled } = await import("@manebra/settlement/server");

  const caller = (userId: string) => appRouter.createCaller({ prisma, userId });
  await caller(args.travelerId).handover.confirmCode({ bidId: args.bidId, code: args.code });
  await onReleaseScheduled(args.bidId);
  const bid = await prisma.bid.findUniqueOrThrow({ where: { id: args.bidId } });
  return {
    released: bid.escrowState === "released",
    settleTxHash: bid.escrowSettleTxHash ?? undefined,
  };
}
