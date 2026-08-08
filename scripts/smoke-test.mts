/**
 * End-to-end smoke test — exercises the WHOLE application money path through the
 * real tRPC routers against a live chain and the local Postgres:
 *
 *   bids.create → bids.accept (escrow open on-chain) → settlement.fundBid
 *   (gasless EIP-3009) → handover.generateCode/confirmCode (schedules release
 *   via Inngest) → onReleaseScheduled (the post-48h Inngest step, invoked
 *   directly to skip the dispute window) → disputes.resolveRefund (2nd bid).
 *
 * Run:  npx tsx scripts/smoke-test.mts
 * Required env: HANDOVER_ESCROW_ADDRESS, USDC_ADDRESS, ATTESTOR_PRIVATE_KEY
 * Optional env: RPC_URL (default local anvil), DATABASE_URL, MINTER_PRIVATE_KEY
 *   (a funded key that may mint/hold USDC: anvil key0 locally; on Base Sepolia
 *   use a wallet holding faucet USDC — funding is then a transfer, not a mint).
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const env = process.env;
env.DATABASE_URL ??= "postgresql://ebenblanks@localhost:5432/manebra";
env.DIRECT_URL ??= env.DATABASE_URL;
env.CHAIN_ENV ??= "testnet";
env.RPC_URL ??= "http://127.0.0.1:8545";
env.LOCAL_WALLET_SEED ??= "manebra-local-dev-seed";
env.HANDOVER_CODE_SECRET ??= "dev-handover-code-secret";
env.INNGEST_EVENT_KEY ??= "local";
env.INNGEST_BASE_URL ??= "http://127.0.0.1:8288";
env.INNGEST_DEV ??= "1";
for (const k of ["HANDOVER_ESCROW_ADDRESS", "USDC_ADDRESS", "ATTESTOR_PRIVATE_KEY"]) {
  if (!env[k]) throw new Error(`${k} must be set`);
}

function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
const step = (msg: string) => console.log(`\n▶ ${msg}`);
const pass = (msg: string) => console.log(`  ✓ ${msg}`);

// ── Stub Inngest event sink (accepts events; handlers are invoked directly) ──
const capturedEvents: Array<{ name: string; data: any }> = [];
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
await new Promise<void>((r) => sink.listen(8288, "127.0.0.1", r));

// ── Imports AFTER env is set (settlement config parses process.env at import) ──
const { appRouter } = await import("../apps/api/src/server/routers/_app.js");
const { prisma } = await import("@manebra/db");
const { onReleaseScheduled, reconcileEscrows } = await import("@manebra/settlement/server");
const { onChainToMirror, centsToUsdc } = await import("@manebra/settlement");
const { HandoverEscrowAbi } = await import("@manebra/settlement/abi");
const { createPublicClient, createWalletClient, http, getAddress } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { baseSepolia } = await import("viem/chains");

const ESCROW = getAddress(env.HANDOVER_ESCROW_ADDRESS!);
const USDC = getAddress(env.USDC_ADDRESS!);
// anvil default key0 — the local minter/relayer of testnet USDC
const MINTER = privateKeyToAccount(
  (env.MINTER_PRIVATE_KEY ??
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`,
);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.RPC_URL) });
const minterClient = createWalletClient({ account: MINTER, chain: baseSepolia, transport: http(env.RPC_URL) });

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const usdcBalance = (a: `0x${string}`) =>
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

const escrowState = async (escrowId: `0x${string}`) =>
  onChainToMirror(Number(await publicClient.readContract({
    address: ESCROW, abi: HandoverEscrowAbi, functionName: "stateOf", args: [escrowId],
  })));

/** Local anvil: mint MockUSDC. Base Sepolia: transfer real faucet USDC from the minter wallet. */
async function giveUsdc(to: `0x${string}`, amount: bigint) {
  const fn = env.SMOKE_USDC_MODE === "transfer" ? "transfer" : "mint";
  const hash = await minterClient.writeContract({ address: USDC, abi: erc20Abi, functionName: fn, args: [to, amount] });
  await publicClient.waitForTransactionReceipt({ hash });
}

const caller = (userId: string) => appRouter.createCaller({ prisma, userId });
const days = (n: number) => new Date(Date.now() + n * 24 * 3600 * 1000);

// ── Cleanup previous smoke runs ──
step("cleanup previous smoke-test data");
const SHOPPER_EMAIL = "smoke-shopper@manebra.test";
const TRAVELER_EMAIL = "smoke-traveler@manebra.test";
{
  const old = await prisma.user.findMany({ where: { email: { in: [SHOPPER_EMAIL, TRAVELER_EMAIL] } } });
  const ids = old.map((u) => u.id);
  if (ids.length) {
    await prisma.payoutLedger.deleteMany({ where: { bid: { travelerId: { in: ids } } } });
    await prisma.handoverCode.deleteMany({ where: { bid: { travelerId: { in: ids } } } });
    await prisma.dispute.deleteMany({ where: { bid: { travelerId: { in: ids } } } });
    await prisma.bid.deleteMany({ where: { travelerId: { in: ids } } });
    await prisma.itemRequest.deleteMany({ where: { shopperId: { in: ids } } });
    await prisma.travelerTrip.deleteMany({ where: { travelerId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}
pass("db clean");

// ── Seed principals (verified + active so verifiedProcedure admits them) ──
step("seed shopper + traveler users, item request, trip");
const shopper = await prisma.user.create({
  data: { id: randomUUID(), email: SHOPPER_EMAIL, fullName: "Smoke Shopper", userRole: "both", isVerified: true, trustScore: 200, totalDeliveries: 10 },
});
const traveler = await prisma.user.create({
  data: { id: randomUUID(), email: TRAVELER_EMAIL, fullName: "Smoke Traveler", userRole: "both", isVerified: true, trustScore: 200, totalDeliveries: 10 },
});
const makeItem = () =>
  prisma.itemRequest.create({
    data: {
      shopperId: shopper.id, itemName: "Smoke Test Console", itemCostCents: 10_000,
      category: "electronics", direction: "us_to_gh", destinationCity: "Accra",
      reviewStatus: "approved", status: "open", expiresAt: days(30),
    },
  });
const item = await makeItem();
const trip = await prisma.travelerTrip.create({
  data: {
    travelerId: traveler.id, direction: "us_to_gh", departureCity: "New York",
    destinationCity: "Accra", departureDate: days(7), luggageCapacityKg: 23, status: "upcoming",
  },
});
pass(`shopper ${shopper.id.slice(0, 8)}… traveler ${traveler.id.slice(0, 8)}…`);

// ═══ HAPPY PATH: create → accept → fund → handover → release ═══
step("bids.create (traveler places bid via tRPC)");
const bid = await caller(traveler.id).bids.create({
  itemRequestId: item.id, tripId: trip.id, travelerFeeCents: 1_500, promisedDeliveryDate: days(10),
});
pass(`bid ${bid.id.slice(0, 8)}… total=$${(bid.totalCents / 100).toFixed(2)} (item $100 + fee $15 + commission $${(bid.commissionCents / 100).toFixed(2)})`);

step("bids.accept (shopper accepts → agent wallets provisioned, escrow OPENED on-chain)");
const accepted = await caller(shopper.id).bids.accept({ bidId: bid.id });
ok(await escrowState(accepted.escrowId as `0x${string}`) === "opened", "on-chain state must be opened");
pass(`escrow ${accepted.escrowId.slice(0, 10)}… opened on-chain`);

step("fund shopper agent wallet with USDC");
const shopperAfterAccept = await prisma.user.findUniqueOrThrow({ where: { id: shopper.id } });
const shopperWallet = getAddress(shopperAfterAccept.walletAddress!);
await giveUsdc(shopperWallet, centsToUsdc(bid.totalCents));
pass(`shopper agent wallet ${shopperWallet} holds ${centsToUsdc(bid.totalCents)} base units`);

step("settlement.fundBid (gasless EIP-3009: agent signs offline, platform relays)");
const funded = await caller(shopper.id).settlement.fundBid({ bidId: bid.id });
ok(await escrowState(accepted.escrowId as `0x${string}`) === "funded", "on-chain state must be funded");
ok(await usdcBalance(ESCROW) === centsToUsdc(bid.totalCents), "escrow must hold the full total");
ok(await usdcBalance(shopperWallet) === 0n, "shopper agent wallet must be emptied");
pass(`funded gasless, tx ${funded.txHash.slice(0, 14)}… — escrow holds $${(bid.totalCents / 100).toFixed(2)}, shopper never touched ETH`);

step("advance purchased → in_transit → arrived (stand-in: those routers are in the original scaffold, not this tree)");
await prisma.bid.update({
  where: { id: bid.id },
  data: { status: "arrived", purchasedAt: new Date(), inTransitAt: new Date(), arrivedAt: new Date() },
});
pass("bid is arrived");

step("handover.generateCode (shopper) → handover.confirmCode (traveler)");
const { code } = await caller(shopper.id).handover.generateCode({ bidId: bid.id });
const confirmed = await caller(traveler.id).handover.confirmCode({ bidId: bid.id, code });
ok(confirmed.status === "delivered", "handover must deliver");
const releaseEvt = capturedEvents.find((e) => e.name === "settlement/escrow.release.scheduled");
ok(releaseEvt, "confirmCode must emit settlement/escrow.release.scheduled to Inngest");
ok(releaseEvt!.data.bidId === bid.id, "scheduled event must carry the bid id");
pass(`delivered; release scheduled for after 48h dispute window (notBefore=${new Date(releaseEvt!.data.notBefore).toISOString()})`);

step("onReleaseScheduled (the Inngest step body — invoked directly to skip the 48h sleepUntil)");
const travelerWallet = getAddress((await prisma.user.findUniqueOrThrow({ where: { id: traveler.id } })).walletAddress!);
const treasury = getAddress(await publicClient.readContract({ address: ESCROW, abi: HandoverEscrowAbi, functionName: "treasury" }) as string);
const treasuryBefore = await usdcBalance(treasury);
await onReleaseScheduled(bid.id);
const subtotal = centsToUsdc(bid.itemCostCentsSnapshot + bid.travelerFeeCents);
ok(await escrowState(accepted.escrowId as `0x${string}`) === "released", "on-chain state must be released");
ok(await usdcBalance(travelerWallet) === subtotal, "traveler agent wallet must receive the subtotal");
ok((await usdcBalance(treasury)) - treasuryBefore === centsToUsdc(bid.commissionCents), "treasury must receive the commission");
const bidFinal = await prisma.bid.findUniqueOrThrow({ where: { id: bid.id } });
ok(bidFinal.escrowState === "released" && !!bidFinal.escrowSettleTxHash, "db mirror must be released with settle tx");
const releaseLedger = await prisma.payoutLedger.findMany({ where: { bidId: bid.id, type: "escrow_release" } });
ok(releaseLedger.length === 2, "ledger must record traveler + commission legs");
pass(`RELEASED: traveler +$${(bid.itemCostCentsSnapshot + bid.travelerFeeCents) / 100}, treasury +$${bid.commissionCents / 100}, 2 ledger legs`);

// ═══ REFUND PATH: fund a 2nd bid, dispute, admin resolves refund on-chain ═══
step("refund path: 2nd bid → accept → fund → dispute → disputes.resolveRefund");
const item2 = await makeItem();
const bid2 = await caller(traveler.id).bids.create({
  itemRequestId: item2.id, tripId: trip.id, travelerFeeCents: 1_500, promisedDeliveryDate: days(10),
});
const accepted2 = await caller(shopper.id).bids.accept({ bidId: bid2.id });
await giveUsdc(shopperWallet, centsToUsdc(bid2.totalCents));
await caller(shopper.id).settlement.fundBid({ bidId: bid2.id });
ok(await escrowState(accepted2.escrowId as `0x${string}`) === "funded", "2nd escrow must be funded");
const dispute = await prisma.dispute.create({
  data: { bidId: bid2.id, openedBy: shopper.id, reason: "item_not_as_described", status: "open" },
});
await caller(shopper.id).disputes.resolveRefund({ bidId: bid2.id, disputeId: dispute.id, notes: "smoke test refund" });
ok(await escrowState(accepted2.escrowId as `0x${string}`) === "refunded", "2nd escrow must be refunded on-chain");
ok(await usdcBalance(shopperWallet) === centsToUsdc(bid2.totalCents), "full total must return to the shopper agent wallet");
const bid2Final = await prisma.bid.findUniqueOrThrow({ where: { id: bid2.id } });
ok(bid2Final.status === "refunded" && bid2Final.escrowState === "refunded", "db must mirror the refund");
const disputeFinal = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
ok(disputeFinal.status === "resolved_refund", "dispute must be resolved_refund");
pass(`REFUNDED: full $${(bid2.totalCents / 100).toFixed(2)} back to shopper, commission forgone, dispute closed`);

// ═══ Reconciliation seam ═══
step("reconcileEscrows (the monitoring seam — both escrows terminal, no drift)");
const report = await reconcileEscrows({ graceMs: 0 });
ok(report.anomalies.length === 0, "no anomalies expected");
pass(`reconcile report: ${JSON.stringify(report)}`);

console.log("\n══════════════════════════════════════════════");
console.log("  SMOKE TEST PASSED — full money path verified");
console.log("══════════════════════════════════════════════");
await prisma.$disconnect();
sink.close();
process.exit(0);
