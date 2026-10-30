/**
 * One Commerce SDK client for the whole process, built from the company
 * credentials. Shared across every shopper's and traveler's buy tool, exactly
 * as the SDK intends ("build it once and share it").
 *
 * Credentials are the same `AGENTCARD_CLIENT_ID` / `AGENTCARD_CLIENT_SECRET`
 * pair the legacy sandbox client uses — the Commerce SDK is the newer surface
 * on the same org account. Sandbox vs production is chosen by WHICH credentials
 * you load (see `npx agent-cards credentials --mode sandbox`), not by a flag;
 * `COMMERCE_SDK_MODE` only guards our own willingness to run live.
 */
import { AgentcardClient } from "@agent-cards/commerce-sdk";

let client: AgentcardClient | null = null;

/** The configured Commerce SDK base, when overridden (sandbox/staging). */
function baseUrl(): string | undefined {
  return process.env.AGENTCARD_COMMERCE_BASE_URL?.trim() || undefined;
}

/** True when both company credentials are present. */
export function commerceConfigured(): boolean {
  return Boolean(
    process.env.AGENTCARD_CLIENT_ID?.trim() && process.env.AGENTCARD_CLIENT_SECRET?.trim(),
  );
}

/**
 * The shared Commerce SDK client, or `null` when unconfigured so callers can
 * fall back to the existing flow. Built lazily and cached for the process.
 */
export function commerceClient(): AgentcardClient | null {
  if (client) return client;
  if (!commerceConfigured()) return null;
  client = new AgentcardClient({
    clientId: process.env.AGENTCARD_CLIENT_ID ?? "",
    clientSecret: process.env.AGENTCARD_CLIENT_SECRET ?? "",
    ...(baseUrl() ? { baseUrl: baseUrl() } : {}),
  });
  return client;
}

/** Reset the cached client — tests only. */
export function resetCommerceClient(): void {
  client = null;
}
