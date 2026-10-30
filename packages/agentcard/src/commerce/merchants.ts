/**
 * `GET /buy/merchants` — can Agentcard pay at a given store? Used as the
 * Rail-A gate and to enrich Manebra's own store list. The call names no
 * shopper, so it can run before anyone connects.
 *
 * We page through `next_cursor` until the store is found or the pages run out;
 * a store absent from every page is one Agentcard has no answer for, which the
 * caller treats as unsupported.
 */
import type { AgentcardClient } from "@agent-cards/commerce-sdk";

export type MerchantSupportReason =
  | "pay_proven"
  | "reach_proven"
  | "gate_refused"
  | "unreached"
  | null;

export type Merchant = {
  kind: "catalog" | "direct";
  slug: string;
  name: string;
  domain: string;
  buys_through?: string;
  supported: boolean;
  supported_reason: MerchantSupportReason;
  supported_detail: string | null;
  held_back?: { until?: string } | null;
  link_status?: string;
  countries?: string[];
};

type MerchantsPage = {
  merchants: Merchant[];
  next_cursor: string | null;
};

export type FindMerchantOptions = {
  /** Only catalog stores (omit to also include direct partners like DoorDash). */
  catalogOnly?: boolean;
  /** Read the list as this connected shopper (adds `link_status`, drops `held_back`). */
  externalUserId?: string;
  /** Max pages to walk before giving up. */
  maxPages?: number;
};

const API_BASE = () =>
  (process.env.AGENTCARD_COMMERCE_BASE_URL?.trim() || "https://api.agentcard.sh").replace(/\/$/, "");

/**
 * Find the merchant whose `domain` exactly matches `domain`, or null. `q`
 * matches part of a name or domain, so we compare the returned `domain`
 * ourselves rather than trusting the first hit.
 */
export async function findMerchant(
  agentcard: AgentcardClient,
  domain: string,
  opts: FindMerchantOptions = {},
): Promise<Merchant | null> {
  const target = domain.trim().toLowerCase();
  const maxPages = opts.maxPages ?? 5;
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${API_BASE()}/buy/merchants`);
    if (opts.catalogOnly) url.searchParams.set("kind", "catalog");
    url.searchParams.set("q", target);
    url.searchParams.set("limit", "50");
    if (opts.externalUserId) url.searchParams.set("external_user_id", opts.externalUserId);
    if (cursor) url.searchParams.set("cursor", cursor);

    const token = await agentcard.bearer();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`buy/merchants failed (${res.status})`);
    const body = (await res.json()) as MerchantsPage;

    const hit = body.merchants.find((m) => m.domain.trim().toLowerCase() === target);
    if (hit) return hit;
    if (!body.next_cursor) return null;
    cursor = body.next_cursor;
  }
  return null;
}

/** True when Agentcard can pay at the store today (and it is not held back). */
export function isPayable(m: Merchant | null): boolean {
  if (!m) return false;
  if (m.held_back) return false;
  return m.supported === true;
}
