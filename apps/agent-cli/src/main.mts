/**
 * MANEBRA DEMO CLI — hand-test the whole agentic platform from your terminal.
 *
 *   npm run demo            (interactive terminal)
 *   npm run demo:linq       (same demo over iMessage via Linq CLI)
 *   DEMO_AUTO=1 npm run demo  (non-interactive; accepts every default)
 *
 * iMessage: install `@linqapp/cli`, `linq signup`/`login`, text your Linq Number
 * first (Shared Line), set LINQ_TO_PHONE in apps/agent-cli/.env, then demo:linq.
 */
import { createPublicClient, createWalletClient, http, getContract, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline/promises";
import { createLinqTransport, type LinqTransport } from "./linq-transport.mts";

import {
  computeFees, formatUsd, endOfLocalDay,
  generateHandoverCode, hashHandoverCode, verifyHandoverCode, HANDOVER_MAX_ATTEMPTS,
} from "@manebra/shared";
import { makeLlm, extractOrder } from "@manebra/llm";
import { searchProducts, hasSerpApiKey, type ProductListing } from "@manebra/catalog";
import { normalizeCity } from "@manebra/calendar";

// Optional local secrets: apps/agent-cli/.env (KEY=VALUE lines).
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}
import { rankTripsForItem, scoreMatch } from "@manebra/agents/matching";
import { runNegotiation, DEFAULT_ENGINE_CONFIG, buildEnvelopePayload, verifyEnvelope } from "@manebra/agents";
import { evaluateSpend, buildFundingAuthorization } from "@manebra/settlement";

// Forge build artifacts (run `npm run contracts:test` or `forge build` first).
const art = (name: string) => {
  const j = JSON.parse(readFileSync(new URL(
    `../../../packages/settlement/contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
};
const A = { MockUSDC: art("MockUSDC"), HandoverEscrow: art("HandoverEscrow") };

const CHAIN_ID = 84532;
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
// anvil's default dev mnemonic — public constant, local chain only
const MNEMONIC = "test test test test test test test test test test test junk";
const AUTO = process.env.DEMO_AUTO === "1";
const USE_LINQ = process.env.DEMO_TRANSPORT === "linq";

// ── tiny console kit ────────────────────────────────────────────────────────
const C = { dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", b: "\x1b[1m", r: "\x1b[31m", x: "\x1b[0m" };
const tag = (t: string, msg: string) => console.log(`${C.c}[${t}]${C.x} ${msg}`);
const okk = (msg: string) => console.log(`  ${C.g}✓${C.x} ${msg}`);
const bad = (msg: string) => console.log(`  ${C.r}✗${C.x} ${msg}`);
const sub = (msg: string) => console.log(`  ${C.dim}${msg}${C.x}`);
const hr = () => console.log(C.dim + "─".repeat(64) + C.x);

const rl = AUTO || USE_LINQ ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
let linq: LinqTransport | null = null;

/** Interactive: terminal, Linq iMessage, or DEMO_AUTO defaults. */
async function ask(q: string, auto?: string): Promise<string> {
  if (AUTO && !USE_LINQ) { console.log(`${C.y}?${C.x} ${q} ${C.dim}(auto: ${auto})${C.x}`); return auto!; }
  if (USE_LINQ && linq) {
    console.log(`${C.y}?${C.x} ${q} ${C.dim}(via iMessage)${C.x}`);
    while (true) {
      const a = (await linq.ask(q, auto)).trim();
      if (a) return a;
      bad("empty iMessage reply — ask again on your phone");
    }
  }
  let a = "";
  while (!a) {
    a = (await rl!.question(`${C.y}?${C.x} ${q} `)).trim();
    if (!a) bad("please type an answer (Enter alone does nothing)");
  }
  return a;
}

async function notifyPhone(msg: string) {
  if (USE_LINQ && linq) {
    try { await linq.say(msg); } catch (e: any) { bad(`linq notify failed: ${e.message}`); }
  }
}

// ── light input parsing (rule-based; the LLM skin comes later) ──────────────
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** Accepts "15th August", "aug 15", "15/08", "2026-08-15". Rolls to next year if past. Always end-of-day. */
function parseDate(text: string): Date | null {
  const t = text.toLowerCase().trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return endOfLocalDay(new Date(+iso[1], +iso[2] - 1, +iso[3]));
  const slash = t.match(/^(\d{1,2})[\/.](\d{1,2})$/);
  const m = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/) ||
            t.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?/);
  let day: number, mon: number;
  if (slash) { day = +slash[1]; mon = +slash[2] - 1; }
  else if (m) {
    day = parseInt(m[1].match(/\d/) ? m[1] : m[2], 10);
    mon = MONTHS[(m[1].match(/\d/) ? m[2] : m[1]).slice(0, 3)];
  } else return null;
  const now = new Date();
  let d = endOfLocalDay(new Date(now.getFullYear(), mon, day));
  if (d < now) d = endOfLocalDay(new Date(now.getFullYear() + 1, mon, day));
  return d;
}
function categoryOf(itemName: string): string | null {
  const t = itemName.toLowerCase();
  if (/iphone|ipad|laptop|macbook|phone|electronic|console|playstation|xbox|camera|drone|watch|airpod|headphone/.test(t)) return "electronics";
  if (/shoe|sneaker|cloth|dress|shirt|jean|jacket|bag/.test(t)) return "clothing_shoes";
  if (/perfume|cream|lotion|makeup|cosmetic|skincare/.test(t)) return "cosmetics_sealed";
  if (/book|novel|vinyl|dvd/.test(t)) return "books_media";
  if (/chocolate|snack|coffee|tea|spice|cereal/.test(t)) return "food_sealed_nonperishable";
  return null;
}
function parseUsd(text: string): number {
  return Math.round(parseFloat(text.replace(/[$,\s]/g, "")) * 100);
}

// ── local agent-wallet provider (real derivation scheme) ────────────────────
const SEED = "demo-seed-for-terminal-session-0123456789";
function agentWallet(userId: string, role: string) {
  const pk = ("0x" + createHmac("sha256", SEED).update(`${role}:${userId}`).digest("hex")) as Hex;
  const account = privateKeyToAccount(pk);
  return { address: account.address, signTypedData: (p: any) => account.signTypedData(p) };
}

// ── ensure a local chain is up (reuse a running anvil, else start one) ───────
let anvilChild: ChildProcess | null = null;
async function ensureChain(pub: ReturnType<typeof createPublicClient>) {
  try { await pub.getChainId(); return; } catch {}
  tag("boot", "no local chain detected — starting anvil…");
  anvilChild = spawn("anvil", ["--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await pub.getChainId(); return; } catch {}
  }
  throw new Error("could not start anvil — is Foundry installed?");
}

async function main() {
  console.log(`\n${C.b}MANEBRA — agentic marketplace demo session${C.x}`);
  const hasLlm = !!(process.env.OPENAI_API_KEY || process.env.HF_TOKEN);
  console.log(`${C.dim}Real engines + real escrow contract on a local chain. ${hasLlm ? "Language intake: live LLM." : "No LLM key set: intake is question-by-question."}${C.x}\n`);

  if (USE_LINQ) {
    const to = process.env.LINQ_TO_PHONE;
    if (!to) {
      bad("DEMO_TRANSPORT=linq requires LINQ_TO_PHONE=+E.164 in apps/agent-cli/.env");
      process.exit(1);
    }
    tag("linq", "routing demo questions to iMessage via Linq CLI…");
    linq = await createLinqTransport({ toPhone: to, log: (m) => console.log(`  ${C.dim}${m}${C.x}`) });
    await notifyPhone("Manebra demo is live — reply here to answer each question.");
  }

  // ── boot the platform ─────────────────────────────────────────────────────
  tag("boot", "connecting local chain, deploying USDC + HandoverEscrow…");
  const chain = { id: CHAIN_ID, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } } as const;
  const transport = http(RPC_URL);
  const pub = createPublicClient({ chain, transport });
  await ensureChain(pub);
  const operator = createWalletClient({ account: mnemonicToAccount(MNEMONIC), chain, transport });
  const attestor = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
  const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: 3 }).address;
  const deploy = async (art: { abi: any; bytecode: Hex }, args: any[]) =>
    (await pub.waitForTransactionReceipt({ hash: await operator.deployContract({ abi: art.abi, bytecode: art.bytecode, args }) })).contractAddress!;
  const usdcAddr = await deploy(A.MockUSDC, []);
  const escrowAddr = await deploy(A.HandoverEscrow, [usdcAddr, treasury, operator.account.address, attestor.address, operator.account.address]);
  const usdc = getContract({ address: usdcAddr, abi: A.MockUSDC.abi, client: { public: pub, wallet: operator } });
  okk(`escrow contract live at ${escrowAddr.slice(0, 10)}…  treasury ${treasury.slice(0, 10)}…`);

  // seeded marketplace: three verified travelers with upcoming trips to Accra
  const now = new Date();
  const day = (n: number) => new Date(now.getTime() + n * 86400_000);
  const travelers = [
    { id: "t-ama",  name: "Ama",  trustScore: 165, avgRating: 4.9, totalDeliveries: 42, minFeeCents: 2500, dep: day(6)  },
    { id: "t-kofi", name: "Kofi", trustScore: 118, avgRating: 4.6, totalDeliveries: 9,  minFeeCents: 1800, dep: day(11) },
    { id: "t-new",  name: "Nana (new)", trustScore: 100, avgRating: null, totalDeliveries: 1, minFeeCents: 1200, dep: day(9) },
  ].map((t) => ({
    ...t,
    trip: { id: `trip-${t.id}`, travelerId: t.id, direction: "us_to_gh" as const, destinationCity: "Accra", departureDate: t.dep, status: "upcoming" as const },
    profile: { id: t.id, isVerified: true, accountStatus: "active" as const, trustScore: t.trustScore, avgRating: t.avgRating, totalDeliveries: t.totalDeliveries },
  }));
  okk(`marketplace seeded: ${travelers.length} verified travelers with upcoming US→Accra trips`);
  for (const t of travelers) sub(`${t.name} departs ${t.trip.departureDate.toDateString()}`);
  hr();

  // ── 1. shopping request: live store listings (like smoke:shop) ───────────
  let itemName: string | undefined, shop: string | undefined, city: string | undefined;
  let productUrl: string | undefined, imageUrl: string | undefined;
  let deadline: Date | null = null;
  let itemCostCents: number | null = null, maxFeeCents: number | null = null;
  let category: string | null = null;
  let shoppingCity = "New York";
  let selected: ProductListing | null = null;

  const llm = makeLlm();
  let queryHint: string | undefined;
  if (llm) {
    tag("agent", `LLM intake is ${C.g}LIVE${C.x} via ${llm.provider} (${llm.model}) — describe what you want.`);
    const raw = await ask("What should I shop for you?",
      "shop an iPhone 16 Pro, deliver to Accra by 15th August, I'll pay up to $30 delivery fee");
    try {
      const o = await extractOrder(llm, raw);
      queryHint = o.itemName ?? raw;
      city = o.city ?? undefined;
      deadline = o.deadline ? parseDate(o.deadline) : null;
      maxFeeCents = o.maxFeeUsd != null ? Math.round(o.maxFeeUsd * 100) : null;
      category = o.category;
      tag("intent", "extracted search query + delivery prefs (prices come from live store listings):");
      sub(`search: ${queryHint}   city: ${city ?? "?"}   deadline: ${deadline ? deadline.toDateString() : "?"}   max fee: ${maxFeeCents != null ? formatUsd(maxFeeCents) : "?"}`);
    } catch (e: any) {
      bad(`LLM intake failed (${e.message}) — asking you directly`);
      queryHint = raw;
    }
  } else {
    tag("agent", `no LLM key — asking you directly (optional: OPENAI_API_KEY / HF_TOKEN in apps/agent-cli/.env)`);
  }

  const searchQuery = queryHint ?? await ask("What do you want to buy?", "iPhone 16 Pro");
  shoppingCity = await ask("Shop in which US city?", shoppingCity);

  if (!hasSerpApiKey()) {
    bad("SERPAPI_API_KEY missing — live store search needs it (see apps/agent-cli/.env.example)");
    process.exit(1);
  }

  tag("catalog", `searching verified stores for "${searchQuery}" near ${shoppingCity}…`);
  let listings: ProductListing[] = [];
  try {
    const results = await searchProducts({ query: searchQuery, shoppingCity });
    listings = results.listings;
  } catch (e: any) {
    bad(`live search failed: ${e.message}`);
    process.exit(1);
  }
  if (!listings.length) {
    bad("no listings from verified stores (Apple, Best Buy, Walmart, Target, Amazon) — try another product name");
    process.exit(1);
  }

  tag("listings", `${listings.length} live offer(s) — pick one:`);
  const listingLines = listings.map((l, i) => {
    const line = `${i + 1}) ${l.storeName} ${formatUsd(l.priceCents)} — ${l.productTitle.slice(0, 80)}`;
    console.log(`  ${C.b}${i + 1})${C.x} ${l.storeName.padEnd(12)} ${formatUsd(l.priceCents).padStart(10)}  ${l.availabilityLabel}`);
    sub(`${l.productTitle}`);
    sub(`${l.productUrl}`);
    return line;
  });
  if (USE_LINQ) {
    await notifyPhone(`Pick a listing — reply with the number:\n${listingLines.join("\n")}`);
  }

  let listingIdx = 0;
  while (true) {
    const choice = await ask(`Which listing? (1–${listings.length})`, "1");
    listingIdx = parseInt(choice, 10) - 1;
    if (listingIdx >= 0 && listingIdx < listings.length) break;
    bad(`enter a number between 1 and ${listings.length}`);
    if (AUTO) { listingIdx = 0; break; }
  }
  selected = listings[listingIdx]!;
  itemName = selected.productTitle;
  shop = selected.storeName;
  productUrl = selected.productUrl;
  imageUrl = selected.imageUrl;
  itemCostCents = selected.priceCents;
  category ??= selected.category;
  okk(`selected ${shop} — ${itemName} at ${formatUsd(itemCostCents)}`);

  city ??= await ask("Deliver to which city in Ghana?", "Accra");
  {
    const normalized = normalizeCity(city);
    if (normalized && normalized !== city) {
      okk(`delivery city normalized: ${city} → ${normalized} (Greater Accra corridor)`);
    }
    city = normalized ?? city;
  }
  while (!deadline) {
    const raw = await ask('Deliver by when? (e.g. "15th August")', "15th August");
    deadline = parseDate(raw);
    if (!deadline) { bad(`couldn't read "${raw}" as a date — try "15th August" or "2026-08-15"`); if (AUTO) deadline = day(15); }
  }
  while (maxFeeCents == null || !Number.isFinite(maxFeeCents) || maxFeeCents <= 0) {
    maxFeeCents = parseUsd(await ask("Max delivery fee you'll pay the traveler in USD? (your agent can never exceed this)", "30"));
    if (!Number.isFinite(maxFeeCents) || maxFeeCents <= 0) { bad("please enter a dollar amount, e.g. 30"); if (AUTO) maxFeeCents = 3_000; }
  }
  category ??= categoryOf(itemName) ??
    (await ask("Category? (electronics / clothing_shoes / cosmetics_sealed / books_media / food_sealed_nonperishable)", "electronics"));
  hr();
  tag("order", `${C.b}"${itemName}"${C.x} from ${shop}`);
  sub(`category: ${category}   shop in: ${shoppingCity}   deliver to: ${city}, Ghana   by: ${deadline.toDateString()}`);
  sub(`item price: ${formatUsd(itemCostCents)}   your max delivery fee: ${formatUsd(maxFeeCents)}`);
  if (productUrl) sub(`product: ${productUrl}`);
  hr();

  // ── 2. compliance gates (kernel) ─────────────────────────────────────────
  tag("compliance", "checking the item against platform rules…");
  const allowed = { us_to_gh: ["electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable"] };
  if (!allowed.us_to_gh.includes(category)) { bad(`category '${category}' is not allowed US→GH — request rejected`); process.exit(1); }
  okk(`category '${category}' allowed for us_to_gh (per-direction allowlist)`);
  okk("item auto-approved for listing (review queue would catch flagged categories)");
  const itemRequest = {
    id: "item-demo", direction: "us_to_gh" as const, destinationCity: city, category, itemCostCents,
    itemUrl: productUrl ?? shop, status: "open" as const, reviewStatus: "auto_approved" as const, expiresAt: endOfLocalDay(deadline),
  };
  tag("platform", `item request created: "${itemName}" from ${shop} · ${formatUsd(itemCostCents)} · deliver to ${city} by ${deadline.toDateString()}`);
  hr();
  // ── 3. matching agent (advisory) ─────────────────────────────────────────
  tag("matching-agent", "scoring candidate trips (kernel-mirrored gates; advisory only)…");
  const cfg = { categoriesByDirection: allowed, newUserDeliveryThreshold: 3, newUserItemCapCents: 50000, highValueItemCents: 100000, highValueMinTrust: 120 };

  const scoreAll = (expiresAt: Date) => {
    const item = { ...itemRequest, expiresAt };
    return travelers.map((t) => ({
      t,
      r: scoreMatch(item as any, t.trip as any, t.profile as any, cfg as any, now),
    }));
  };
  const printScores = (scored: ReturnType<typeof scoreAll>) => {
    for (const { t, r } of scored) {
      if (r.eligible) okk(`${t.name.padEnd(12)} departs ${t.trip.departureDate.toDateString()}  trust ${t.trustScore}  → score ${r.score}`);
      else bad(`${t.name.padEnd(12)} ineligible: ${r.reasons.join(", ")}`);
    }
    // Trips that miss only on the deliver-by window (same city / otherwise eligible)
    const dateAlts = scored
      .filter(({ r }) => !r.eligible && r.reasons.includes("departs_after_item_expiry")
        && r.reasons.every((x) => x === "departs_after_item_expiry"))
      .sort((a, b) => a.t.trip.departureDate.getTime() - b.t.trip.departureDate.getTime());
    if (dateAlts.length) {
      tag("other-dates", "travelers after your deadline (extend to include them):");
      for (const { t } of dateAlts) {
        sub(`${t.name} departs ${t.trip.departureDate.toDateString()} — after your ${itemRequest.expiresAt.toDateString()} deadline`);
      }
    }
    return dateAlts;
  };

  let scored = scoreAll(itemRequest.expiresAt);
  let dateAlts = printScores(scored);
  let ranked = rankTripsForItem(itemRequest as any, travelers.map((t) => ({ trip: t.trip as any, traveler: t.profile as any })), cfg as any, now);

  if (ranked.length === 0 && dateAlts.length > 0) {
    const next = dateAlts[0]!;
    const extendTo = endOfLocalDay(next.t.trip.departureDate);
    const ans = await ask(
      `No trips by ${itemRequest.expiresAt.toDateString()}. Extend deadline to ${extendTo.toDateString()} (${next.t.name}) and match? (y/n)`,
      "y",
    );
    if (/^y(es)?$/i.test(ans)) {
      itemRequest.expiresAt = extendTo;
      okk(`deadline extended to ${itemRequest.expiresAt.toDateString()}`);
      scored = scoreAll(itemRequest.expiresAt);
      dateAlts = printScores(scored);
      ranked = rankTripsForItem(itemRequest as any, travelers.map((t) => ({ trip: t.trip as any, traveler: t.profile as any })), cfg as any, now);
    }
  }

  if (ranked.length === 0) {
    tag("available", "no matches for your city/deadline — marketplace inventory:");
    for (const t of travelers) {
      sub(`${t.name} → ${t.trip.destinationCity} on ${t.trip.departureDate.toDateString()} (trust ${t.trustScore})`);
    }
    const earliest = [...travelers].sort((a, b) => a.trip.departureDate.getTime() - b.trip.departureDate.getTime())[0]!;
    const ans = await ask(
      `Switch delivery to ${earliest.trip.destinationCity} and extend deadline to ${earliest.trip.departureDate.toDateString()} (${earliest.name})? (y/n)`,
      "y",
    );
    if (/^y(es)?$/i.test(ans)) {
      itemRequest.destinationCity = earliest.trip.destinationCity;
      itemRequest.expiresAt = endOfLocalDay(earliest.trip.departureDate);
      city = itemRequest.destinationCity;
      okk(`updated: deliver to ${city} by ${itemRequest.expiresAt.toDateString()}`);
      scored = scoreAll(itemRequest.expiresAt);
      dateAlts = printScores(scored);
      ranked = rankTripsForItem(itemRequest as any, travelers.map((t) => ({ trip: t.trip as any, traveler: t.profile as any })), cfg as any, now);
    }
  }

  if (ranked.length === 0) { bad("no eligible trips before your deadline — agent would keep watching"); await notifyPhone("No eligible travelers before your deadline — demo stopped."); process.exit(0); }
  const names = ranked.map((r: any, i: number) => `${i + 1}) ${travelers.find((t) => t.id === r.traveler.id)!.name} (score ${r.score})`).join("  ");
  const pick = parseInt(await ask(`Matching agent proposes: ${names}. Choose`, "1"), 10) - 1;
  const chosen = travelers.find((t) => t.id === (ranked[pick] as any).traveler.id)!;
  tag("platform", `you selected ${chosen.name} — proposal converts to a negotiation, then a bid`);
  hr();

  // ── 4. envelope-bounded negotiation ──────────────────────────────────────
  tag("negotiation", "both principals sign constraint envelopes (EIP-712, agent wallets)…");
  const shopperAgent = agentWallet("you", "shopper_agent");
  const travelerAgent = agentWallet(chosen.id, "traveler_agent");
  const nowS = Math.floor(Date.now() / 1000);
  const sEnv = { role: "shopper" as const, itemRequestId: itemRequest.id, tripId: chosen.trip.id, limitFeeCents: maxFeeCents, validUntil: nowS + 3600 };
  const tEnv = { role: "traveler" as const, itemRequestId: itemRequest.id, tripId: chosen.trip.id, limitFeeCents: chosen.minFeeCents, validUntil: nowS + 3600 };
  const sSig = await shopperAgent.signTypedData(buildEnvelopePayload(CHAIN_ID, sEnv));
  okk(`your envelope: max fee ${formatUsd(maxFeeCents)} — verified: ${await verifyEnvelope(CHAIN_ID, { ...sEnv, signer: shopperAgent.address, signature: sSig })}`);
  sub(`${chosen.name}'s envelope: min fee hidden from your agent (information hiding is structural)`);
  const result = runNegotiation(sEnv, tEnv, DEFAULT_ENGINE_CONFIG, nowS);
  for (const o of result.transcript.offers) {
    sub(`round ${o.round} · ${o.by === "shopper" ? "your agent" : chosen.name + "'s agent"} offers ${formatUsd(o.feeCents)}`);
  }
  if (result.outcome !== "deal") { bad(`no deal (${(result as any).reason}) — your max and their min don't overlap`); process.exit(0); }
  tag("negotiation", `${C.g}DEAL at ${formatUsd(result.feeCents!)}${C.x} in ${result.totalMoves} moves (provably inside both envelopes)`);
  hr();

  // ── 5. server fee math → bid ─────────────────────────────────────────────
  const fees = computeFees(itemCostCents, result.feeCents!);
  tag("fees", "server-side computeFees (clients never send totals):");
  sub(`item ${formatUsd(fees.itemCostCents)} + traveler fee ${formatUsd(fees.travelerFeeCents)} = subtotal ${formatUsd(fees.subtotalCents)}`);
  sub(`commission (15%) ${formatUsd(fees.commissionCents)}  →  YOU PAY ${C.b}${formatUsd(fees.totalCents)}${C.x}`);
  hr();

  // ── 6. escrow open + gasless funding ─────────────────────────────────────
  tag("escrow", "bid accepted → opening on-chain escrow with server-authored terms…");
  const escrowId = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const payeeAmount = BigInt(fees.subtotalCents) * 10000n, feeAmount = BigInt(fees.commissionCents) * 10000n, total = payeeAmount + feeAmount;
  let h = await operator.writeContract({ address: escrowAddr, abi: A.HandoverEscrow.abi, functionName: "open", args: [escrowId, shopperAgent.address, travelerAgent.address, payeeAmount, feeAmount, nowS + 14 * 86400] });
  okk(`escrow OPENED  tx ${h.slice(0, 14)}…  (only 3 possible destinations, fixed forever)`);
  await operator.writeContract({ address: usdcAddr, abi: A.MockUSDC.abi, functionName: "mint", args: [shopperAgent.address, total] });
  sub(`your agent wallet ${shopperAgent.address.slice(0, 10)}… funded with test USDC · ETH balance: 0 (and it stays 0)`);

  tag("spend-policy", "your agent proposes the payment; the guardrail kernel decides…");
  const policy = { maxPerTxBaseUnits: 5000_000000n, dailyCapBaseUnits: 10000_000000n, allowedContracts: [escrowAddr] };
  const verdict = evaluateSpend(policy, { to: escrowAddr, amountBaseUnits: total }, { spentTodayBaseUnits: 0n });
  if (!verdict.allowed) { bad(`policy rejected: ${verdict.reason}`); process.exit(1); }
  okk(`allowed: ${formatUsd(fees.totalCents)} ≤ per-tx cap, escrow on allowlist — signature may be produced`);
  const [, tname, tver] = (await pub.readContract({ address: usdcAddr, abi: A.MockUSDC.abi, functionName: "eip712Domain" })) as any[];
  const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const auth = buildFundingAuthorization({ tokenDomain: { name: tname, version: tver, chainId: CHAIN_ID, verifyingContract: usdcAddr }, from: shopperAgent.address, escrow: escrowAddr, totalBaseUnits: total, nonce, validAfter: 0n, validBefore: BigInt(nowS + 900) });
  const fSig = await shopperAgent.signTypedData(auth);
  const v = parseInt(fSig.slice(130, 132), 16), r = fSig.slice(0, 66) as Hex, s = ("0x" + fSig.slice(66, 130)) as Hex;
  h = await operator.writeContract({ address: escrowAddr, abi: A.HandoverEscrow.abi, functionName: "fundWithAuthorization", args: [escrowId, 0n, BigInt(nowS + 900), nonce, v, r, s] });
  okk(`escrow FUNDED gaslessly  tx ${h.slice(0, 14)}…  — you signed offline; the platform relayed and paid gas`);
  sub(`escrow now holds ${formatUsd(fees.totalCents)} · your agent sent 0 transactions, holds 0 ETH`);
  hr();

  // ── 7. the journey + handover ────────────────────────────────────────────
  tag("journey", `${chosen.name} buys the ${itemName} → departs → arrives in ${city} (funded → purchased → in_transit → arrived)`);
  const code = generateHandoverCode();
  const codeHash = hashHandoverCode(code, "bid-demo", "demo-secret");
  tag("handover", `platform shows YOU (the shopper) a one-time code: ${C.b}${code}${C.x}`);
  sub("you inspect the item in person, then read the code to the traveler");
  await notifyPhone(`Your handover code is ${code}. When prompted, enter it (or have the traveler enter it).`);
  let attempts = 0, confirmed = false;
  while (attempts < HANDOVER_MAX_ATTEMPTS && !confirmed) {
    const entered = await ask(`${chosen.name} enters the 6-digit code`, code);
    if (verifyHandoverCode(entered, "bid-demo", codeHash, "demo-secret")) {
      confirmed = true; okk("code verified (constant-time HMAC, bid-bound) → arrived → delivered");
    } else { attempts++; bad(`incorrect code (attempt ${attempts}/${HANDOVER_MAX_ATTEMPTS})`); }
  }
  if (!confirmed) { bad("lockout — support flow takes over. Funds stay safely in escrow."); process.exit(0); }
  hr();

  // ── 8. dispute window → release ──────────────────────────────────────────
  tag("dispute-window", "48h window opens. Settlement is FINAL, so release waits it out.");
  const dispute = (await ask("Open a dispute? (y/N)", "n")).toLowerCase().startsWith("y");
  const attTypes = { HandoverAttestation: [{ name: "escrowId", type: "bytes32" }, { name: "action", type: "uint8" }, { name: "deadline", type: "uint64" }] } as const;
  const attDomain = { name: "ManebraHandoverEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrowAddr } as const;
  if (dispute) {
    tag("dispute", "admin resolves → REFUND path: full total returns to you, commission forgone");
    const dl = BigInt(nowS + 900);
    const refSig = await attestor.signTypedData({ domain: attDomain, types: attTypes, primaryType: "HandoverAttestation", message: { escrowId, action: 2, deadline: dl } });
    h = await operator.writeContract({ address: escrowAddr, abi: A.HandoverEscrow.abi, functionName: "refund", args: [escrowId, dl, refSig] });
    okk(`REFUNDED  tx ${h.slice(0, 14)}…  your agent wallet balance: ${formatUsd(Number((await usdc.read.balanceOf([shopperAgent.address]) as bigint) / 10000n))}`);
  } else {
    sub("(fast-forwarding 48h — in production this is the Inngest sleepUntil)");
    const dl = BigInt(nowS + 900);
    const relSig = await attestor.signTypedData({ domain: attDomain, types: attTypes, primaryType: "HandoverAttestation", message: { escrowId, action: 1, deadline: dl } });
    h = await operator.writeContract({ address: escrowAddr, abi: A.HandoverEscrow.abi, functionName: "release", args: [escrowId, dl, relSig] });
    tag("release", `attestation signed by the platform's attestor key → escrow releases  tx ${h.slice(0, 14)}…`);
    okk(`${chosen.name}'s agent wallet received ${formatUsd(Number((await usdc.read.balanceOf([travelerAgent.address]) as bigint) / 10000n))} (item + fee)`);
    okk(`Manebra treasury received ${formatUsd(Number((await usdc.read.balanceOf([treasury]) as bigint) / 10000n))} commission`);
    sub(`trust: ${chosen.name} +10 delivery bonus (would apply in DB) · reconciliation cron keeps the mirror honest`);
  }
  hr();
  console.log(`${C.b}Session complete.${C.x} Everything above was the real system: real fee math, real matching`);
  console.log(`scorer, real negotiation engine, real HMAC handover, real escrow contract on a live`);
  console.log(`local chain. The LLM layer, when added, only translates language → this pipeline.\n`);
  await notifyPhone("Manebra demo complete — thanks!");
  if (rl) rl.close();
  if (linq) await linq.close();
  if (anvilChild) anvilChild.kill();
}

main().catch(async (e) => {
  console.error(e);
  try { if (linq) await linq.close(); } catch {}
  process.exit(1);
});
