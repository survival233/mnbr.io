/** Fast rule-based intent for mid-flow corrections (no LLM required). */

export type IntentKind =
  | "restart"
  | "reject_results"
  | "new_query"
  | "select"
  | "yes"
  | "no"
  | "slot_answer"
  | "unclear";

export type ClassifiedIntent = {
  kind: IntentKind;
  /** 1-based index when kind === "select" */
  index?: number;
  /** Normalized product query when kind === "new_query" */
  query?: string;
};

const REJECT_RE =
  /^(wrong|nope|nah|none|not\s+(these|those|it|right)|try\s+again|search\s+again|something\s+else|different|not\s+what\s+i|these\s+aren'?t|that'?s\s+wrong|restart\s+search)\b/i;

const YES_RE =
  /^(y|yes|ok|okay|sure|yeah|yep|yup|affirmative|that'?s\s+fine|that'?s\s+ok(?:ay)?|that\s+works|sounds\s+good)\b/i;
const NO_RE = /^(n|no|nope|nah|cancel|never\s?mind)\b/i;
const RESTART_RE = /^(hi|hello|hey|start|restart|menu)\b/i;

/** Light typo / plural fixes before SerpAPI (e.g. airpod → airpods). */
export function normalizeSearchQuery(raw: string): string {
  let q = raw.trim().replace(/\s+/g, " ");
  q = q.replace(/\bair\s*pods?\b/gi, "AirPods");
  q = q.replace(/\bairpod\b/gi, "AirPods");
  q = q.replace(/\bps\s*5\b/gi, "PS5");
  q = q.replace(/\biphone\s*(\d+)/gi, "iPhone $1");
  return q;
}

import { fuzzyMatchIndex } from "@manebra/dialog";
export { fuzzyMatchIndex };

export function classifyIntent(
  text: string,
  ctx: {
    step: string;
    listingCount?: number;
    travelerCount?: number;
    listingLabels?: Array<{ label: string; haystack?: string }>;
    travelerLabels?: Array<{ label: string; haystack?: string }>;
  },
): ClassifiedIntent {
  const t = text.trim();
  if (!t) return { kind: "unclear" };

  if (RESTART_RE.test(t) && t.length < 40) return { kind: "restart" };

  if (ctx.step === "await_listing") {
    if (REJECT_RE.test(t) || /^(no|none)\.?$/i.test(t)) {
      const rest = t
        .replace(REJECT_RE, "")
        .replace(/^(no|none)\.?/i, "")
        .replace(/^[,:\-\s]+/, "")
        .trim();
      if (rest.length >= 3 && !/^(these|those|it|right|again)$/i.test(rest)) {
        return { kind: "new_query", query: normalizeSearchQuery(rest) };
      }
      return { kind: "reject_results" };
    }

    const idx = fuzzyMatchIndex(t, ctx.listingLabels ?? [], { labelOnly: true });
    if (idx != null) return { kind: "select", index: idx };

    // Free-text product correction while staring at wrong results
    if (!/^\d+$/.test(t) && !YES_RE.test(t) && t.length >= 3) {
      return { kind: "new_query", query: normalizeSearchQuery(t) };
    }
  }

  if (ctx.step === "await_traveler") {
    const idx = fuzzyMatchIndex(t, ctx.travelerLabels ?? []);
    if (idx != null) return { kind: "select", index: idx };
  }

  if (ctx.step === "await_shopping_city" && REJECT_RE.test(t)) {
    return { kind: "reject_results" };
  }

  // Mid-flow “actually search X instead” anywhere after product was set
  const instead = t.match(
    /^(?:actually|instead|search(?:\s+for)?|look\s+for|find)\s+(.+)/i,
  );
  if (
    instead?.[1] &&
    ["await_listing", "await_shopping_city", "await_delivery_city", "await_deadline", "await_max_fee"].includes(
      ctx.step,
    )
  ) {
    return { kind: "new_query", query: normalizeSearchQuery(instead[1]) };
  }

  if (YES_RE.test(t)) return { kind: "yes" };
  if (NO_RE.test(t)) return { kind: "no" };

  return { kind: "slot_answer" };
}
