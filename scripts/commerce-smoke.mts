/**
 * COMMERCE SMOKE — sandbox checks for the Commerce SDK surface (Vector C).
 * Exits non-zero on any failure. Run: npm run smoke:commerce
 *
 * Sandbox-safe: it only reads merchant support and exercises the pure
 * reconcile/compliance gates. It places NO order and charges nothing. Use
 * sandbox credentials (`npx agent-cards credentials --mode sandbox`).
 *
 * 1. Client builds from AGENTCARD_CLIENT_ID / AGENTCARD_CLIENT_SECRET.
 * 2. `GET /buy/merchants` answers for a known retail store (amazon.com).
 * 3. Reconcile gate: exact match ok, overage flagged, cheaper order refundable.
 * 4. Compliance gate: a prohibited category is denied, general goods allowed.
 *
 * For the full model-in-the-loop walkthrough the SDK ships, run:
 *   node node_modules/@agent-cards/commerce-sdk/examples/walkthrough.mjs
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
}

const { commerceClient, commerceConfigured, findMerchant } = await import(
  "../packages/agentcard/src/commerce/index"
);
const { reconcileOrderTotal } = await import("../packages/agentcard/src/commerce/vector-c");
const { checkItem } = await import("../packages/compliance/src/index");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok  ${msg}`);
}

console.log("commerce smoke — sandbox, no orders placed");

// 1. Client
if (!commerceConfigured()) {
  throw new Error("AGENTCARD_CLIENT_ID / AGENTCARD_CLIENT_SECRET unset (use sandbox credentials)");
}
const client = commerceClient();
assert(client, "Commerce client built from company credentials");

// 2. Merchant support (read-only, names no shopper)
const amazon = await findMerchant(client!, "amazon.com", { catalogOnly: true });
assert(amazon, "buy/merchants answered for amazon.com");
console.log(`      amazon.com supported=${amazon?.supported} reason=${amazon?.supported_reason}`);

// 3. Reconcile gate (pure)
assert(reconcileOrderTotal(5000, 5000).ok, "reconcile: exact total matches");
assert(!reconcileOrderTotal(5000, 9000).ok, "reconcile: overage is flagged, not released");
assert(reconcileOrderTotal(5000, 4200).status === "under", "reconcile: cheaper order is refundable");

// 4. Compliance gate (pure) — delegates to @manebra/shared categories.ts
assert(!checkItem("weapons", "us_to_gh").ok, "compliance: prohibited category denied");
assert(checkItem("electronics", "us_to_gh").ok, "compliance: allowlisted category cleared");
assert(!checkItem("electronics", "gh_to_us").ok, "compliance: wrong-direction category denied");

console.log("commerce smoke passed");
