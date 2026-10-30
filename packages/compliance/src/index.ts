/**
 * Product compliance gate for cross-border carry.
 *
 * This is NOT a second source of truth — it delegates to the real eligibility
 * sheet in `@manebra/shared` (`categories.ts`, "Prohibited-items enforcement —
 * PRD v4.0 §16.2"): the per-direction allowlist the matching kernel already
 * enforces (`category_not_allowed_for_direction` in
 * packages/agents/src/matching/score.ts). This module just turns that same
 * list into an allow / flag / deny verdict with shopper-safe messaging, so the
 * Commerce buy path can gate on the exact rules matching already uses.
 *
 * It runs at two moments:
 *   1. In the shopper flow, before a traveler is matched — refuse a prohibited
 *      item up front.
 *   2. Just before the Commerce SDK buy tool places the order — last gate on
 *      the real category + direction.
 */
import {
  isCategoryAllowed,
  ALWAYS_REVIEW_CATEGORIES,
  CATEGORIES_BY_DIRECTION,
  type TripDirection,
} from "@manebra/shared";

export type { TripDirection };

export type ComplianceDisposition = "allow" | "flag" | "deny";

export type ComplianceVerdict = {
  disposition: ComplianceDisposition;
  /** True only for `allow`. `flag` means a mandatory review step first. */
  ok: boolean;
  /** Machine-readable reasons, aligned with the matching kernel's codes. */
  reasons: string[];
  /** Short, shopper-safe explanation. */
  message: string;
};

const MESSAGE: Record<ComplianceDisposition, string> = {
  allow: "This item is cleared to carry on this route.",
  flag: "This item is allowed but needs a customs review before a traveler can carry it.",
  deny: "We can't carry this item on this route.",
};

/**
 * Check one item category against one trip direction, using the shared sheet.
 * Pure and synchronous so both call sites gate without I/O.
 *
 * - not on the direction's allowlist -> `deny`
 * - allowed but in `ALWAYS_REVIEW_CATEGORIES` -> `flag`
 * - otherwise -> `allow`
 */
export function checkItem(category: string, direction: TripDirection): ComplianceVerdict {
  if (!isCategoryAllowed(direction, category)) {
    return {
      disposition: "deny",
      ok: false,
      reasons: ["category_not_allowed_for_direction"],
      message: MESSAGE.deny,
    };
  }
  if (ALWAYS_REVIEW_CATEGORIES.includes(category)) {
    return {
      disposition: "flag",
      ok: false,
      reasons: ["always_review_category"],
      message: MESSAGE.flag,
    };
  }
  return { disposition: "allow", ok: true, reasons: [], message: MESSAGE.allow };
}

/** The eligible categories for a direction — handy for the agent's copy. */
export function allowedCategories(direction: TripDirection): readonly string[] {
  return CATEGORIES_BY_DIRECTION[direction] ?? [];
}
