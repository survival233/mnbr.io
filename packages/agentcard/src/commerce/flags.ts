/**
 * Feature flags for the Commerce SDK surface (Vector C: the traveler's
 * purchasing tool, run after escrow has HELD the shopper's funds).
 *
 * Off by default. This surface is independent of the legacy pay-sheet
 * (`client.ts`) and the per-user card MCP (`oauth.ts`/`mcp.ts`); turning it on
 * never changes those, and it never touches the live settlement path on its
 * own — the caller wires it in explicitly.
 */

/** True when the Commerce SDK buy tool is allowed to run at all. */
export function commerceEnabled(): boolean {
  const v = process.env.COMMERCE_SDK_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/**
 * True unless the operator has explicitly opted into live orders. Sandbox runs
 * the whole flow against real stores but stops before payment, so nothing is
 * charged. We default to sandbox so a stray `COMMERCE_SDK_ENABLED=1` can never
 * place a real order or charge a real card.
 */
export function commerceSandbox(): boolean {
  const v = process.env.COMMERCE_SDK_MODE?.trim().toLowerCase();
  return v !== "live" && v !== "production";
}
