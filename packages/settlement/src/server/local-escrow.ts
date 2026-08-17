/**
 * Anvil open / fund / release used by the demo CLI and by Shopper/Traveler
 * when DEMO_LOCAL_CHAIN=1. Same contract calls as the original agent-cli block.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, getContract, type Hex, type Address } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { computeFees, generateHandoverCode } from "@manebra/shared";
import { evaluateSpend, buildFundingAuthorization } from "../core";

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";
const SEED = "demo-seed-for-terminal-session-0123456789";

export function demoLocalChain(): boolean {
  return (
    process.env.PAYMENT_MODE === "demo" ||
    process.env.DEMO_LOCAL_CHAIN === "1" ||
    process.env.DEMO_LOCAL_CHAIN === "true"
  );
}

const art = (name: string) => {
  const j = JSON.parse(
    readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"),
  );
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
};

function artifacts() {
  return { MockUSDC: art("MockUSDC"), HandoverEscrow: art("HandoverEscrow") };
}

export function agentWallet(userId: string, role: string) {
  const pk = ("0x" + createHmac("sha256", SEED).update(`${role}:${userId}`).digest("hex")) as Hex;
  const account = privateKeyToAccount(pk);
  return { address: account.address, signTypedData: (p: any) => account.signTypedData(p) };
}

function chainClients() {
  const usdcAddr = process.env.USDC_ADDRESS as Address | undefined;
  const escrowAddr = process.env.HANDOVER_ESCROW_ADDRESS as Address | undefined;
  if (!usdcAddr || !escrowAddr) {
    throw new Error("USDC_ADDRESS and HANDOVER_ESCROW_ADDRESS required for local escrow");
  }
  const chain = {
    id: CHAIN_ID,
    name: "local",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  } as const;
  const transport = http(RPC_URL);
  const pub = createPublicClient({ chain, transport });
  const operator = createWalletClient({ account: mnemonicToAccount(MNEMONIC), chain, transport });
  const attestorKey = process.env.ATTESTOR_PRIVATE_KEY as Hex | undefined;
  const attestor = attestorKey
    ? privateKeyToAccount(attestorKey)
    : mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
  const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: 3 }).address;
  return { usdcAddr, escrowAddr, chain, transport, pub, operator, attestor, treasury };
}

export type FundLocalResult = {
  escrowId: Hex;
  bidId: string;
  openTxHash: Hex;
  fundTxHash: Hex;
  shopperAddress: Address;
  travelerAddress: Address;
  fees: ReturnType<typeof computeFees>;
  handoverCode: string;
  totalCents: number;
};

export async function fundLocalEscrow(input: {
  shopperUserId: string;
  travelerId: string;
  itemCostCents: number;
  travelerFeeCents: number;
}): Promise<FundLocalResult> {
  const A = artifacts();
  const { usdcAddr, escrowAddr, pub, operator } = chainClients();
  const fees = computeFees(input.itemCostCents, input.travelerFeeCents);
  const shopperAgent = agentWallet(input.shopperUserId, "shopper_agent");
  const travelerAgent = agentWallet(input.travelerId, "traveler_agent");
  const nowS = Math.floor(Date.now() / 1000);
  const escrowId = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const payeeAmount = BigInt(fees.subtotalCents) * 10000n;
  const feeAmount = BigInt(fees.commissionCents) * 10000n;
  const total = payeeAmount + feeAmount;

  const openTxHash = await operator.writeContract({
    address: escrowAddr,
    abi: A.HandoverEscrow.abi,
    functionName: "open",
    args: [escrowId, shopperAgent.address, travelerAgent.address, payeeAmount, feeAmount, nowS + 14 * 86400],
  });
  await pub.waitForTransactionReceipt({ hash: openTxHash });

  await operator.writeContract({
    address: usdcAddr,
    abi: A.MockUSDC.abi,
    functionName: "mint",
    args: [shopperAgent.address, total],
  });

  const policy = { maxPerTxBaseUnits: 5000_000000n, dailyCapBaseUnits: 10000_000000n, allowedContracts: [escrowAddr] };
  const verdict = evaluateSpend(policy, { to: escrowAddr, amountBaseUnits: total }, { spentTodayBaseUnits: 0n });
  if (!verdict.allowed) throw new Error(`policy rejected: ${verdict.reason}`);

  const [, tname, tver] = (await pub.readContract({
    address: usdcAddr,
    abi: A.MockUSDC.abi,
    functionName: "eip712Domain",
  })) as any[];
  const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const auth = buildFundingAuthorization({
    tokenDomain: { name: tname, version: tver, chainId: CHAIN_ID, verifyingContract: usdcAddr },
    from: shopperAgent.address,
    escrow: escrowAddr,
    totalBaseUnits: total,
    nonce,
    validAfter: 0n,
    validBefore: BigInt(nowS + 900),
  });
  const fSig = await shopperAgent.signTypedData(auth);
  const v = parseInt(fSig.slice(130, 132), 16);
  const r = fSig.slice(0, 66) as Hex;
  const s = ("0x" + fSig.slice(66, 130)) as Hex;
  const fundTxHash = await operator.writeContract({
    address: escrowAddr,
    abi: A.HandoverEscrow.abi,
    functionName: "fundWithAuthorization",
    args: [escrowId, 0n, BigInt(nowS + 900), nonce, v, r, s],
  });
  await pub.waitForTransactionReceipt({ hash: fundTxHash });

  return {
    escrowId,
    bidId: `demo-${escrowId.slice(2, 10)}`,
    openTxHash,
    fundTxHash,
    shopperAddress: shopperAgent.address,
    travelerAddress: travelerAgent.address,
    fees,
    handoverCode: generateHandoverCode(),
    totalCents: fees.totalCents,
  };
}

export async function settleLocalEscrow(input: {
  escrowId: Hex;
  action: "release" | "refund";
  shopperAddress?: Address;
  travelerAddress?: Address;
}): Promise<{
  txHash: Hex;
  shopperBalanceCents: number;
  travelerBalanceCents: number;
  treasuryBalanceCents: number;
}> {
  const A = artifacts();
  const { usdcAddr, escrowAddr, pub, operator, attestor, treasury } = chainClients();
  const nowS = Math.floor(Date.now() / 1000);
  const attTypes = {
    HandoverAttestation: [
      { name: "escrowId", type: "bytes32" },
      { name: "action", type: "uint8" },
      { name: "deadline", type: "uint64" },
    ],
  } as const;
  const attDomain = {
    name: "ManebraHandoverEscrow",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: escrowAddr,
  } as const;
  const dl = BigInt(nowS + 900);
  const action = input.action === "release" ? 1 : 2;
  const sig = await attestor.signTypedData({
    domain: attDomain,
    types: attTypes,
    primaryType: "HandoverAttestation",
    message: { escrowId: input.escrowId, action, deadline: dl },
  });
  const fn = input.action === "release" ? "release" : "refund";
  const txHash = await operator.writeContract({
    address: escrowAddr,
    abi: A.HandoverEscrow.abi,
    functionName: fn,
    args: [input.escrowId, dl, sig],
  });
  await pub.waitForTransactionReceipt({ hash: txHash });

  const usdc = getContract({
    address: usdcAddr,
    abi: A.MockUSDC.abi,
    client: { public: pub, wallet: operator },
  });
  const cents = async (addr: Address) =>
    Number(((await usdc.read.balanceOf([addr])) as bigint) / 10000n);
  return {
    txHash,
    shopperBalanceCents: input.shopperAddress ? await cents(input.shopperAddress) : 0,
    travelerBalanceCents: input.travelerAddress ? await cents(input.travelerAddress) : 0,
    treasuryBalanceCents: await cents(treasury),
  };
}
