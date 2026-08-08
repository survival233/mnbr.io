/**
 * MCP SMOKE — drives the full marketplace lifecycle through apps/mcp as a real
 * MCP client (the same way Claude/Cursor would): seed → item → match → bid →
 * accept (escrow on-chain) → gasless fund → handover → release. Exits non-zero
 * on any failure.  Run: npm run smoke:mcp   (needs Postgres; auto-starts anvil)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "mcp-smoke", version: "0.0.1" });
await client.connect(new StdioClientTransport({
  command: "npx",
  args: ["tsx", "apps/mcp/src/server.mts"],
  cwd: new URL("..", import.meta.url).pathname,
}));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  console.log(`✓ ${name}`);
  try { return JSON.parse(text); } catch { return text; }
};

const tools = await client.listTools();
console.log(`connected — ${tools.tools.length} tools exposed`);

const seed = await call("setup_marketplace");
const item = await call("create_item_request", {
  shopperId: seed.shopperId, itemName: "iPhone 16 Pro", priceUsd: 999,
  city: "Accra", category: "electronics",
  deadlineIso: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
});
const matches = await call("find_matches", { itemRequestId: item.itemRequestId });
if (!matches.length) throw new Error("no eligible matches");
console.log(`  top match: ${matches[0].name} (score ${matches[0].score})`);

const bid = await call("place_bid", {
  itemRequestId: item.itemRequestId, tripId: matches[0].tripId, travelerId: matches[0].travelerId,
  feeUsd: 28, promisedDeliveryIso: new Date(Date.now() + 10 * 86400_000).toISOString(),
});
console.log(`  total ${bid.total}, commission ${bid.commission}`);

await call("accept_bid", { bidId: bid.bidId });
const funded = await call("fund_bid", { bidId: bid.bidId });
console.log(`  escrow holds ${funded.escrowHolds} (on-chain: ${funded.onChainState})`);

await call("advance_to_arrived", { bidId: bid.bidId });
const { code } = await call("generate_handover_code", { bidId: bid.bidId });
await call("confirm_handover", { bidId: bid.bidId, code });
const done = await call("release_escrow", { bidId: bid.bidId });

if (done.escrowState !== "released" || done.onChainState !== "released") {
  throw new Error(`expected released, got db=${done.escrowState} chain=${done.onChainState}`);
}
console.log(`\nMCP SMOKE PASSED — bid ${done.bidId} released: traveler paid ${done.travelerFee} + item, treasury ${done.commission}`);
await client.close();
process.exit(0);
