/**
 * Settlement router — [MERGE, new] the shopper's "Pay" action.
 * Policy-gated EIP-3009 authorization from the shopper's agent wallet, relayed
 * by the platform (user holds ZERO ETH), then accepted → funded via the state
 * machine with ledger records.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { assertTransition, type BidStatus } from "@manebra/shared";
import { bidIdToEscrowId, centsToUsdc } from "@manebra/settlement";
import {
  attestorClient,
  settlementPublicClient,
  settlementConfig,
  authorizeEscrowFunding,
  SpendRejectedError,
} from "@manebra/settlement/server";
import { HandoverEscrowAbi } from "@manebra/settlement/abi";
import { router, verifiedProcedure } from "../trpc.js";
import { getWalletProvider } from "../wallets.js";

const erc20MetaAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function usdcAddress(): `0x${string}` {
  const a = process.env.USDC_ADDRESS as `0x${string}` | undefined;
  if (!a) throw new Error("USDC_ADDRESS is not set");
  return a;
}

export const settlementRouter = router({
  /** SHOPPER funds the accepted bid. Gasless: offline signature + platform relay. */
  fundBid: verifiedProcedure
    .input(z.object({ bidId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const bid = await ctx.prisma.bid.findUnique({
        where: { id: input.bidId },
        include: { itemRequest: true },
      });
      if (!bid || bid.itemRequest.shopperId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND" });
      if (bid.status !== "accepted" || bid.escrowState !== "opened") {
        throw new TRPCError({ code: "CONFLICT", message: "Bid is not awaiting funding." });
      }
      assertTransition(bid.status as BidStatus, "funded", "system");

      const provider = getWalletProvider();
      const shopperW = await provider.getOrCreateWallet(ctx.user.id, "shopper_agent");

      // Token EIP-712 domain read ON-CHAIN (never hardcoded).
      const usdc = usdcAddress();
      const [name, version] = await Promise.all([
        settlementPublicClient.readContract({ address: usdc, abi: erc20MetaAbi, functionName: "name" }),
        settlementPublicClient.readContract({ address: usdc, abi: erc20MetaAbi, functionName: "version" }),
      ]);

      // Daily window: sum today's escrow_fund ledger rows for this shopper's bids.
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const agg = await ctx.prisma.payoutLedger.aggregate({
        _sum: { amountCents: true },
        where: {
          type: "escrow_fund",
          status: "succeeded",
          createdAt: { gte: since },
          bid: { itemRequest: { shopperId: ctx.user.id } },
        },
      });
      const spentToday = centsToUsdc(agg._sum.amountCents ?? 0);

      let auth;
      try {
        auth = await authorizeEscrowFunding({
          wallet: shopperW,
          policy: {
            maxPerTxBaseUnits: centsToUsdc(Number(process.env.SPEND_MAX_PER_TX_CENTS ?? 50_000)),
            dailyCapBaseUnits: centsToUsdc(Number(process.env.SPEND_DAILY_CAP_CENTS ?? 100_000)),
            allowedContracts: [settlementConfig.escrowAddress],
          },
          window: { spentTodayBaseUnits: spentToday },
          tokenDomain: { name, version, chainId: attestorClient.chain!.id, verifyingContract: usdc },
          escrow: settlementConfig.escrowAddress,
          totalBaseUnits: centsToUsdc(bid.totalCents),
        });
      } catch (e) {
        if (e instanceof SpendRejectedError) {
          throw new TRPCError({ code: "FORBIDDEN", message: `Spending policy: ${e.reason}` });
        }
        throw e;
      }

      // Relay (platform pays gas; the shopper sent zero transactions).
      const escrowId = bidIdToEscrowId(bid.id);
      const v = parseInt(auth.signature.slice(130, 132), 16);
      const r = auth.signature.slice(0, 66) as `0x${string}`;
      const s = ("0x" + auth.signature.slice(66, 130)) as `0x${string}`;
      const txHash = await attestorClient.writeContract({
        address: settlementConfig.escrowAddress,
        abi: HandoverEscrowAbi,
        functionName: "fundWithAuthorization",
        args: [escrowId, auth.validAfter, auth.validBefore, auth.nonce, v, r, s],
      });

      await ctx.prisma.$transaction([
        ctx.prisma.bid.update({
          where: { id: bid.id },
          data: { status: "funded", fundedAt: new Date(), escrowState: "funded", escrowFundTxHash: txHash },
        }),
        ctx.prisma.payoutLedger.create({
          data: {
            bidId: bid.id,
            type: "escrow_fund",
            amountCents: bid.totalCents,
            currency: bid.currency,
            onchainTxHash: txHash,
            status: "succeeded",
          },
        }),
        ctx.prisma.itemRequest.update({ where: { id: bid.itemRequestId }, data: { status: "funded" } }),
      ]);

      return { status: "funded" as const, txHash };
    }),
});
