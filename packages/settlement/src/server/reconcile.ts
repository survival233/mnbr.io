/**
 * Reconciliation job — the settlement-agent monitoring seam.
 * Corrected to real mnbr/manebra shapes: prisma from @manebra/db, ledger writes
 * to payout_ledger (no BidEvent table), single Bid.status enum untouched —
 * this job only ever heals the escrow MIRROR columns, never Bid.status.
 *
 * Chain is source of truth. Benign forward drift (missed/late event) is healed;
 * mirror-ahead-of-chain and terminal conflicts are escalated, never auto-fixed.
 */
import { prisma, Prisma } from "@manebra/db";
import { createPublicClient, http, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { classifyDrift, onChainToMirror, type MirrorEscrowState } from "../core/escrow-state";
import { settlementConfig } from "./config";
import { HandoverEscrowAbi } from "../core/abi";

import { inngest } from "./events";

const CHAIN = settlementConfig.chainEnv === "mainnet" ? base : baseSepolia;
const publicClient = createPublicClient({ chain: CHAIN, transport: http(settlementConfig.rpcUrl) });
const ESCROW = settlementConfig.escrowAddress;

export interface ReconcileOptions {
  /** Skip bids touched within this window to avoid racing unconfirmed txs. Default 2m. */
  graceMs?: number;
  /** Max escrows per multicall batch. Default 100. */
  batchSize?: number;
}

export interface ReconcileReport {
  checked: number;
  inSync: number;
  healed: number;
  anomalies: Array<{ bidId: string; mirror: MirrorEscrowState; chain: MirrorEscrowState; reason: string }>;
  readErrors: string[];
}

export async function reconcileEscrows(opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const graceMs = opts.graceMs ?? 2 * 60 * 1000;
  const batchSize = opts.batchSize ?? 100;
  const cutoff = new Date(Date.now() - graceMs);

  // Non-terminal mirrors can still drift forward; recently-updated bids are skipped.
  const bids = (await prisma.bid.findMany({
    where: {
      escrowId: { not: null },
      escrowState: { in: ["none", "opened", "funded"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, escrowId: true, escrowState: true },
  })) as Array<{ id: string; escrowId: string; escrowState: MirrorEscrowState }>;

  const report: ReconcileReport = { checked: 0, inSync: 0, healed: 0, anomalies: [], readErrors: [] };

  for (let i = 0; i < bids.length; i += batchSize) {
    const batch = bids.slice(i, i + batchSize);
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: batch.map((b) => ({
        address: ESCROW,
        abi: HandoverEscrowAbi,
        functionName: "stateOf" as const,
        args: [b.escrowId as Hex],
      })),
    });

    for (let j = 0; j < batch.length; j++) {
      const bid = batch[j];
      const r = results[j];
      report.checked++;
      if (r.status !== "success") {
        report.readErrors.push(bid.id);
        continue;
      }
      const chain = onChainToMirror(Number(r.result));
      const verdict = classifyDrift(bid.escrowState, chain);

      if (verdict.kind === "in_sync") {
        report.inSync++;
      } else if (verdict.kind === "heal") {
        await heal(bid.id, bid.escrowId as Hex, verdict.to);
        report.healed++;
      } else {
        report.anomalies.push({ bidId: bid.id, mirror: verdict.mirror, chain: verdict.chain, reason: verdict.reason });
        await inngest.send({
          name: "settlement/anomaly.detected",
          data: { bidId: bid.id, mirror: verdict.mirror, chain: verdict.chain, reason: verdict.reason },
        });
      }
    }
  }

  return report;
}

/** Heal the mirror toward the chain. Terminal heals also backfill the ledger record
 *  the normal path would have written (idempotent via the onchainTxHash check). */
async function heal(bidId: string, escrowId: Hex, to: MirrorEscrowState) {
  const isTerminal = to === "released" || to === "refunded";
  const txHash = isTerminal ? await findSettlementTx(escrowId, to) : null;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.bid.update({
      where: { id: bidId },
      data: { escrowState: to, ...(txHash ? { escrowSettleTxHash: txHash } : {}) },
    });
    if (isTerminal && txHash) {
      const already = await tx.payoutLedger.findFirst({ where: { bidId, onchainTxHash: txHash } });
      if (!already) {
        const bid = await tx.bid.findUniqueOrThrow({ where: { id: bidId } });
        await tx.payoutLedger.create({
          data: {
            bidId,
            type: to === "released" ? "escrow_release" : "escrow_refund",
            amountCents: to === "released"
              ? bid.itemCostCentsSnapshot + bid.travelerFeeCents
              : bid.totalCents,
            currency: bid.currency,
            onchainTxHash: txHash,
            status: "succeeded",
            metadata: { healedByReconciliation: true },
          },
        });
      }
    }
  });
}

/** Best-effort: recover the settlement tx hash from on-chain logs. */
async function findSettlementTx(escrowId: Hex, to: MirrorEscrowState): Promise<Hex | null> {
  try {
    const eventAbi = (HandoverEscrowAbi as readonly any[]).find(
      (e) => e.type === "event" && e.name === (to === "released" ? "EscrowReleased" : "EscrowRefunded"),
    );
    const logs = await publicClient.getLogs({
      address: ESCROW,
      event: eventAbi,
      args: { escrowId },
      fromBlock: "earliest",
      toBlock: "latest",
    });
    return (logs[0]?.transactionHash as Hex) ?? null;
  } catch {
    return null;
  }
}
