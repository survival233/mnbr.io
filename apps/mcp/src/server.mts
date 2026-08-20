/**
 * MANEBRA MCP SERVER — the whole platform exposed as Model Context Protocol tools.
 *
 * Any MCP client (Claude Desktop, Cursor, an SDK agent…) can drive the real
 * marketplace lifecycle: seed users → create item request → match travelers →
 * place/accept bids (on-chain escrow) → gasless funding → handover → release
 * or dispute/refund. Every tool calls the REAL tRPC routers / engines — the
 * LLM orchestrates, the kernel computes; no model ever authors an amount.
 *
 * Run:  npm run mcp   (stdio transport)
 *
 * Config (env or apps/mcp/.env): DATABASE_URL, RPC_URL, HANDOVER_ESCROW_ADDRESS,
 * USDC_ADDRESS, ATTESTOR_PRIVATE_KEY… If no escrow is configured and the RPC is
 * local, the server auto-starts anvil and deploys MockUSDC + HandoverEscrow.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// ── config (env file → defaults) ────────────────────────────────────────────
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}
const env = process.env;
env.DATABASE_URL ??= "postgresql://ebenblanks@localhost:5432/manebra";
env.DIRECT_URL ??= env.DATABASE_URL;
env.CHAIN_ENV ??= "testnet";
env.RPC_URL ??= "http://127.0.0.1:8545";
env.LOCAL_WALLET_SEED ??= "manebra-local-dev-seed";
env.HANDOVER_CODE_SECRET ??= "dev-handover-code-secret";
// spend-policy caps still guard every funding signature — sized for demo orders
env.SPEND_MAX_PER_TX_CENTS ??= "500000"; // $5,000/tx
env.SPEND_DAILY_CAP_CENTS ??= "1000000"; // $10,000/day
env.INNGEST_EVENT_KEY ??= "local";
env.INNGEST_BASE_URL ??= "http://127.0.0.1:8288";
env.INNGEST_DEV ??= "1";

const log = (...a: unknown[]) => console.error("[manebra-mcp]", ...a); // stdout is the MCP protocol

// ── in-process Inngest event sink (captures scheduled-release events) ───────
const capturedEvents: Array<{ name: string; data: any }> = [];
await new Promise<void>((resolve) => {
  const sink = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        for (const e of Array.isArray(parsed) ? parsed : [parsed]) capturedEvents.push(e);
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ids: [randomUUID()], status: 200 }));
    });
  });
  sink.on("error", () => { log("port 8288 in use — assuming an Inngest dev server is running"); resolve(); });
  sink.listen(8288, "127.0.0.1", () => resolve());
});

// ── chain bootstrap: reuse configured escrow, or deploy a local stack ───────
import { createPublicClient, createWalletClient, http, getAddress, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const MNEMONIC = "test test test test test test test test test test test junk"; // anvil dev accounts (public)
const chain = { id: 84532, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL!] } } } as const;
const pub = createPublicClient({ chain, transport: http(env.RPC_URL) });
const isLocal = /127\.0\.0\.1|localhost/.test(env.RPC_URL!);

async function ensureLocalChain() {
  try { await pub.getChainId(); return; } catch {}
  if (!isLocal) throw new Error(`cannot reach RPC_URL ${env.RPC_URL}`);
  log("starting anvil…");
  spawn("anvil", ["--chain-id", "84532", "--silent"], { stdio: "ignore", detached: true }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await pub.getChainId(); return; } catch {}
  }
  throw new Error("could not start anvil — is Foundry installed?");
}

const art = (name: string) => {
  const j = JSON.parse(readFileSync(new URL(
    `../../../packages/settlement/contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi as any, bytecode: j.bytecode.object as Hex };
};

await ensureLocalChain();
const deployer = createWalletClient({ account: mnemonicToAccount(MNEMONIC), chain, transport: http(env.RPC_URL) });
if (!env.HANDOVER_ESCROW_ADDRESS || !env.USDC_ADDRESS) {
  if (!isLocal) throw new Error("HANDOVER_ESCROW_ADDRESS/USDC_ADDRESS must be set for non-local RPC");
  log("no escrow configured — deploying MockUSDC + HandoverEscrow to the local chain…");
  const deploy = async (a: { abi: any; bytecode: Hex }, args: any[]) =>
    (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) })).contractAddress!;
  const attestorAcc = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
  const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: 3 }).address;
  env.USDC_ADDRESS = await deploy(art("MockUSDC"), []);
  env.HANDOVER_ESCROW_ADDRESS = await deploy(art("HandoverEscrow"), [
    env.USDC_ADDRESS, treasury, attestorAcc.address, attestorAcc.address, deployer.account.address,
  ]);
  // anvil dev key #1 — public constant, operator+attestor on the local deployment
  env.ATTESTOR_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  log(`deployed escrow ${env.HANDOVER_ESCROW_ADDRESS} usdc ${env.USDC_ADDRESS}`);
}
const ESCROW = getAddress(env.HANDOVER_ESCROW_ADDRESS!);
const USDC = getAddress(env.USDC_ADDRESS!);

// ── platform imports AFTER env is final (settlement config parses at import) ─
const { appRouter } = await import("../../api/src/server/routers/_app.js");
const { prisma } = await import("@manebra/db");
const { onReleaseScheduled, reconcileEscrows } = await import("@manebra/settlement/server");
const { onChainToMirror, centsToUsdc, HandoverEscrowAbi } = await import("@manebra/settlement");
const { rankTripsForItem } = await import("@manebra/agents/matching");

const caller = (userId: string) => appRouter.createCaller({ prisma, userId });
const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;
const usdcBalance = (a: `0x${string}`) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const chainState = async (escrowId: string) =>
  onChainToMirror(Number(await pub.readContract({ address: ESCROW, abi: HandoverEscrowAbi, functionName: "stateOf", args: [escrowId as Hex] })));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const json = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true as const });

async function bidView(bidId: string) {
  const b = await prisma.bid.findUniqueOrThrow({ where: { id: bidId }, include: { itemRequest: true, ledgerEntries: true } });
  return {
    bidId: b.id, item: b.itemRequest.itemName, status: b.status, escrowState: b.escrowState,
    onChainState: b.escrowId ? await chainState(b.escrowId) : "none",
    total: usd(b.totalCents), travelerFee: usd(b.travelerFeeCents), commission: usd(b.commissionCents),
    ledger: b.ledgerEntries.map((l) => ({ type: l.type, amount: usd(l.amountCents), tx: l.onchainTxHash })),
  };
}

// ── the MCP surface ──────────────────────────────────────────────────────────
const server = new McpServer({ name: "manebra", version: "0.1.0" });

server.registerTool("platform_status", {
  description: "Health snapshot: database counts, chain connectivity, escrow contract address and USDC held.",
}, async () => json({
  chainId: await pub.getChainId(), escrow: ESCROW, usdc: USDC,
  escrowUsdcBalance: (await usdcBalance(ESCROW)).toString(),
  users: await prisma.user.count(), itemRequests: await prisma.itemRequest.count(), bids: await prisma.bid.count(),
}));

server.registerTool("setup_marketplace", {
  description: "Seed (or reset) a demo marketplace: one verified shopper and three verified travelers with upcoming trips to destinationCity. Returns their ids — use them in the other tools.",
  inputSchema: {
    destinationCity: z.string().min(1),
    departureCity: z.string().min(1).optional(),
  },
}, async (a) => {
  const dest = a.destinationCity;
  const origin = a.departureCity ?? "New York";
  const emails = ["mcp-shopper@manebra.test", "mcp-ama@manebra.test", "mcp-kofi@manebra.test", "mcp-nana@manebra.test"];
  const old = await prisma.user.findMany({ where: { email: { in: emails } } });
  const oldIds = old.map((u) => u.id);
  if (oldIds.length) {
    await prisma.payoutLedger.deleteMany({ where: { bid: { travelerId: { in: oldIds } } } });
    await prisma.handoverCode.deleteMany({ where: { bid: { travelerId: { in: oldIds } } } });
    await prisma.dispute.deleteMany({ where: { bid: { travelerId: { in: oldIds } } } });
    await prisma.bid.deleteMany({ where: { OR: [{ travelerId: { in: oldIds } }, { itemRequest: { shopperId: { in: oldIds } } }] } });
    await prisma.itemRequest.deleteMany({ where: { shopperId: { in: oldIds } } });
    await prisma.travelerTrip.deleteMany({ where: { travelerId: { in: oldIds } } });
    await prisma.user.deleteMany({ where: { id: { in: oldIds } } });
  }
  const mk = (email: string, name: string, extra: object) =>
    prisma.user.create({ data: { id: randomUUID(), email, fullName: name, userRole: "both", isVerified: true, ...extra } });
  const day = (n: number) => new Date(Date.now() + n * 86400_000);
  const shopper = await mk(emails[0], "MCP Shopper", { trustScore: 150, totalDeliveries: 5 });
  const travelers = [
    { u: await mk(emails[1], "Ama", { trustScore: 165, totalDeliveries: 42, avgRating: 4.9 }), dep: 6 },
    { u: await mk(emails[2], "Kofi", { trustScore: 118, totalDeliveries: 9, avgRating: 4.6 }), dep: 11 },
    { u: await mk(emails[3], "Nana (new)", { trustScore: 100, totalDeliveries: 1 }), dep: 9 },
  ];
  const trips: Awaited<ReturnType<typeof prisma.travelerTrip.create>>[] = [];
  for (const t of travelers) {
    trips.push(await prisma.travelerTrip.create({
      data: { travelerId: t.u.id, direction: "us_to_gh", departureCity: origin, destinationCity: dest, departureDate: day(t.dep), luggageCapacityKg: 23, status: "upcoming" },
    }));
  }
  return json({
    shopperId: shopper.id,
    travelers: travelers.map((t, i) => ({ travelerId: t.u.id, name: t.u.fullName, tripId: trips[i].id, departs: trips[i].departureDate })),
  });
});

server.registerTool("search_products", {
  description:
    "LIVE product search across verified stores (Apple, Best Buy, Walmart, Target, Amazon) via Google Shopping. " +
    "Requires SERPAPI_API_KEY — not each store's API. Returns store, title, price, availability, URL, image.",
  inputSchema: {
    shopperId: z.string().uuid(),
    query: z.string(),
    shoppingCity: z.string().default("New York"),
  },
}, async (a) => json(await caller(a.shopperId).items.search({ query: a.query, shoppingCity: a.shoppingCity })));

server.registerTool("create_from_listing", {
  description:
    "After live search: shopper selects a listingId, adds destination/date/qty, creates Waiting-for-Traveler request.",
  inputSchema: {
    shopperId: z.string().uuid(),
    listingId: z.string(),
    shoppingCity: z.string().default("New York"),
    destinationCity: z.string().min(1),
    neededByIso: z.string(),
    quantity: z.number().int().min(1).max(10).default(1),
    notes: z.string().optional(),
  },
}, async (a) => json(await caller(a.shopperId).items.createFromListing({
  listingId: a.listingId,
  shoppingCity: a.shoppingCity,
  destinationCity: a.destinationCity,
  neededBy: new Date(a.neededByIso),
  quantity: a.quantity,
  notes: a.notes,
})));

server.registerTool("create_shopping_request", {
  description:
    "Manual shopper path — paste store, title, price, URL (when not using live search). " +
    "Creates Waiting-for-Traveler request and notifies matching travelers.",
  inputSchema: {
    shopperId: z.string().uuid(),
    itemName: z.string(),
    retailerName: z.string().describe("e.g. Apple Store, Best Buy"),
    priceUsd: z.number().positive(),
    productUrl: z.string().optional(),
    shoppingCity: z.string().default("New York"),
    destinationCity: z.string().min(1),
    neededByIso: z.string().describe("YYYY-MM-DD"),
    quantity: z.number().int().min(1).max(10).default(1),
    notes: z.string().optional(),
    category: z.enum(["electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable"]).default("electronics"),
  },
}, async (a) => json(await caller(a.shopperId).items.createManual({
  itemName: a.itemName,
  retailerName: a.retailerName,
  priceUsd: a.priceUsd,
  productUrl: a.productUrl,
  shoppingCity: a.shoppingCity,
  destinationCity: a.destinationCity,
  neededBy: new Date(a.neededByIso),
  quantity: a.quantity,
  notes: a.notes,
  category: a.category,
})));

server.registerTool("list_traveler_jobs", {
  description: "Traveler job inbox: product image/name/link, store, price, delivery city, fee, required date. Accept or Decline next.",
  inputSchema: { travelerId: z.string().uuid() },
}, async (a) => json(await caller(a.travelerId).matches.myJobs()));

server.registerTool("accept_job", {
  description: "Traveler Accepts a job alert: reserves the shopping request and notifies the shopper to pay.",
  inputSchema: { travelerId: z.string().uuid(), proposalId: z.string().uuid() },
}, async (a) => json(await caller(a.travelerId).matches.accept({ proposalId: a.proposalId })));

server.registerTool("decline_job", {
  description: "Traveler Declines a job alert.",
  inputSchema: { travelerId: z.string().uuid(), proposalId: z.string().uuid() },
}, async (a) => json(await caller(a.travelerId).matches.decline({ proposalId: a.proposalId })));

server.registerTool("create_item_request", {
  description: "Shopper lists an item to be bought in the US and hand-delivered to the destination city. Amounts in USD.",
  inputSchema: {
    shopperId: z.string().uuid(),
    itemName: z.string(),
    priceUsd: z.number().positive(),
    city: z.string().min(1),
    category: z.enum(["electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable"]),
    deadlineIso: z.string().describe("delivery deadline, YYYY-MM-DD"),
    shopUrl: z.string().optional(),
  },
}, async (a) => {
  const { normalizeCity } = await import("@manebra/calendar");
  const { endOfLocalDay } = await import("@manebra/shared");
  const city = normalizeCity(a.city) ?? a.city;
  const iso = a.deadlineIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const neededBy = iso
    ? endOfLocalDay(new Date(+iso[1], +iso[2] - 1, +iso[3]))
    : endOfLocalDay(new Date(a.deadlineIso));
  const item = await prisma.itemRequest.create({
    data: {
      shopperId: a.shopperId, itemName: a.itemName, itemCostCents: Math.round(a.priceUsd * 100),
      category: a.category, direction: "us_to_gh", destinationCity: city, itemUrl: a.shopUrl,
      reviewStatus: "approved", status: "open", expiresAt: neededBy,
    },
  });
  return json({ itemRequestId: item.id, itemName: item.itemName, destinationCity: city, price: usd(item.itemCostCents) });
});

server.registerTool("find_matches", {
  description: "Run the REAL matching agent: score all upcoming trips against an item request (trust, ratings, timing, compliance gates). Returns ranked eligible travelers.",
  inputSchema: { itemRequestId: z.string().uuid() },
}, async (a) => {
  const item = await prisma.itemRequest.findUniqueOrThrow({ where: { id: a.itemRequestId } });
  const trips = await prisma.travelerTrip.findMany({ where: { status: "upcoming", direction: item.direction }, include: { traveler: true } });
  const cfg = { categoriesByDirection: { us_to_gh: ["electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable"] }, newUserDeliveryThreshold: 3, newUserItemCapCents: 50_000, highValueItemCents: 100_000, highValueMinTrust: 120 };
  const ranked = rankTripsForItem(item as any, trips.map((t) => ({
    trip: t as any,
    traveler: { id: t.travelerId, isVerified: t.traveler.isVerified, accountStatus: t.traveler.accountStatus, trustScore: t.traveler.trustScore, avgRating: t.traveler.avgRating ? Number(t.traveler.avgRating) : null, totalDeliveries: t.traveler.totalDeliveries } as any,
  })), cfg as any, new Date());
  return json(ranked.map((r: any) => ({
    travelerId: r.traveler.id,
    name: trips.find((t) => t.travelerId === r.traveler.id)!.traveler.fullName,
    tripId: r.trip.id, score: r.score, departs: r.trip.departureDate,
  })));
});

server.registerTool("place_bid", {
  description: "Traveler bids on an item request with their delivery fee (USD), via the real bids.create router (all marketplace gates enforced).",
  inputSchema: { itemRequestId: z.string().uuid(), tripId: z.string().uuid(), travelerId: z.string().uuid(), feeUsd: z.number().positive(), promisedDeliveryIso: z.string() },
}, async (a) => {
  const bid = await caller(a.travelerId).bids.create({
    itemRequestId: a.itemRequestId, tripId: a.tripId,
    travelerFeeCents: Math.round(a.feeUsd * 100), promisedDeliveryDate: new Date(a.promisedDeliveryIso),
  });
  return json({ bidId: bid.id, total: usd(bid.totalCents), commission: usd(bid.commissionCents), note: "server computed all amounts (computeFees) — clients only sent the fee" });
});

server.registerTool("accept_bid", {
  description: "Shopper accepts a bid: agent wallets are provisioned and the escrow is OPENED on-chain (real transaction).",
  inputSchema: { bidId: z.string().uuid() },
}, async (a) => {
  const bid = await prisma.bid.findUniqueOrThrow({ where: { id: a.bidId }, include: { itemRequest: true } });
  const res = await caller(bid.itemRequest.shopperId).bids.accept({ bidId: a.bidId });
  return json({ ...res, onChainState: await chainState(res.escrowId) });
});

server.registerTool("fund_bid", {
  description: "Shopper funds the escrow GASLESSLY (EIP-3009: agent wallet signs offline, platform relays). On the local chain the shopper's agent wallet is topped up with test USDC first.",
  inputSchema: { bidId: z.string().uuid() },
}, async (a) => {
  const bid = await prisma.bid.findUniqueOrThrow({ where: { id: a.bidId }, include: { itemRequest: { include: { shopper: true } } } });
  if (isLocal) {
    const wallet = bid.itemRequest.shopper.walletAddress;
    if (!wallet) return fail("shopper has no agent wallet yet — accept_bid first");
    const h = await deployer.writeContract({ address: USDC, abi: erc20Abi, functionName: "mint", args: [getAddress(wallet), centsToUsdc(bid.totalCents)] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const res = await caller(bid.itemRequest.shopperId).settlement.fundBid({ bidId: a.bidId });
  return json({ ...res, escrowHolds: (await usdcBalance(ESCROW)).toString(), onChainState: await chainState(bid.escrowId!) });
});

server.registerTool("advance_to_arrived", {
  description: "Stand-in for the purchase/transit routers (not in this tree): moves a funded bid to 'arrived' so handover can happen.",
  inputSchema: { bidId: z.string().uuid() },
}, async (a) => {
  await prisma.bid.update({ where: { id: a.bidId }, data: { status: "arrived", purchasedAt: new Date(), inTransitAt: new Date(), arrivedAt: new Date() } });
  return json(await bidView(a.bidId));
});

server.registerTool("generate_handover_code", {
  description: "Shopper generates the one-time 6-digit handover code (HMAC stored, plaintext returned once).",
  inputSchema: { bidId: z.string().uuid() },
}, async (a) => {
  const bid = await prisma.bid.findUniqueOrThrow({ where: { id: a.bidId }, include: { itemRequest: true } });
  const { code } = await caller(bid.itemRequest.shopperId).handover.generateCode({ bidId: a.bidId });
  return json({ code, note: "give this to the traveler at the physical handover" });
});

server.registerTool("confirm_handover", {
  description: "Traveler enters the code the shopper gave them. On success the bid becomes 'delivered' and escrow release is scheduled after the 48h dispute window.",
  inputSchema: { bidId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) },
}, async (a) => {
  const bid = await prisma.bid.findUniqueOrThrow({ where: { id: a.bidId } });
  const res = await caller(bid.travelerId).handover.confirmCode({ bidId: a.bidId, code: a.code });
  const evt = capturedEvents.find((e) => e.name === "settlement/escrow.release.scheduled" && e.data?.bidId === a.bidId);
  return json({ ...res, releaseScheduled: evt ? new Date(evt.data.notBefore).toISOString() : "event not captured" });
});

server.registerTool("release_escrow", {
  description: "Execute the post-dispute-window release NOW (the Inngest step body, invoked directly instead of waiting 48h). Pays traveler + treasury on-chain.",
  inputSchema: { bidId: z.string().uuid() },
}, async (a) => {
  await onReleaseScheduled(a.bidId);
  return json(await bidView(a.bidId));
});

server.registerTool("open_dispute_and_refund", {
  description: "Open a dispute on a funded bid and resolve it as an on-chain refund: full total returns to the shopper, commission forgone.",
  inputSchema: { bidId: z.string().uuid(), reason: z.enum(["item_not_as_described", "item_damaged", "no_show", "payment_issue", "other"]).default("item_not_as_described"), notes: z.string().default("resolved via MCP") },
}, async (a) => {
  const bid = await prisma.bid.findUniqueOrThrow({ where: { id: a.bidId }, include: { itemRequest: true } });
  const dispute = await prisma.dispute.create({ data: { bidId: a.bidId, openedBy: bid.itemRequest.shopperId, reason: a.reason, status: "open" } });
  await caller(bid.itemRequest.shopperId).disputes.resolveRefund({ bidId: a.bidId, disputeId: dispute.id, notes: a.notes });
  return json(await bidView(a.bidId));
});

server.registerTool("get_bid", {
  description: "Full picture of a bid: DB status, escrow mirror, LIVE on-chain state, and the money ledger.",
  inputSchema: { bidId: z.string().uuid() },
}, async (a) => json(await bidView(a.bidId)));

server.registerTool("sync_traveler_calendar", {
  description:
    "Sync traveler calendar events and notify them of shopper jobs to their city. " +
    "Use provider=google|outlook for cloud accounts; provider=apple for phone iCal/Calendar.app " +
    "(flights added only on the phone — never on Google/Outlook). Pass title/location/dates only.",
  inputSchema: {
    travelerId: z.string().uuid(),
    provider: z.enum(["google", "outlook", "apple", "ics"]).default("google"),
    events: z.array(z.object({
      externalEventId: z.string(),
      title: z.string().optional(),
      location: z.string().optional(),
      description: z.string().optional(),
      startsAt: z.string().describe("ISO datetime of departure"),
      endsAt: z.string().optional(),
    })).min(1),
  },
}, async (a) => {
  const events = a.events.map((e) => ({
    ...e,
    provider: a.provider,
    startsAt: new Date(e.startsAt),
    endsAt: e.endsAt ? new Date(e.endsAt) : null,
  }));
  const res =
    a.provider === "apple" || a.provider === "ics"
      ? await caller(a.travelerId).trips.syncDeviceCalendar({ provider: a.provider, events })
      : await caller(a.travelerId).trips.ingestCalendarEvents({ provider: a.provider, events });
  return json(res);
});

server.registerTool("list_job_alerts", {
  description: "List pending job alerts for a traveler (shopper requests matched to their synced trips).",
  inputSchema: { travelerId: z.string().uuid() },
}, async (a) => json(await caller(a.travelerId).trips.jobAlerts()));

server.registerTool("reconcile", {
  description: "Run the reconciliation seam: compare every non-terminal escrow mirror against on-chain truth; heal benign drift, report anomalies.",
}, async () => json(await reconcileEscrows({ graceMs: 0 })));

// wrap handlers so thrown errors return isError instead of crashing the server
const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready — escrow ${ESCROW} on chain ${await pub.getChainId()}`);
