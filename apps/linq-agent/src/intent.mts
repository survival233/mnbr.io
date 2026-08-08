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

const YES_RE = /^(y|yes|ok|okay|sure|yeah|yep|yup|affirmative)\b/i;
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

function ordinalOrNumber(text: string): number | null {
  const t = text.trim().toLowerCase();
  const bare = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\.?$/);
  if (bare) return parseInt(bare[1], 10);
  const word: Record<string, number> = {
    one: 1,
    first: 1,
    two: 2,
    second: 2,
    three: 3,
    third: 3,
    four: 4,
    fourth: 4,
    five: 5,
    fifth: 5,
  };
  if (word[t] != null) return word[t]!;
  const numbered = t.match(/\b(?:number|option|#)\s*(\d{1,2})\b/);
  if (numbered) return parseInt(numbered[1], 10);
  const leading = t.match(/^(\d{1,2})\b/);
  if (leading && t.length <= 4) return parseInt(leading[1], 10);
  return null;
}

export function fuzzyMatchIndex(
  text: string,
  candidates: Array<{ label: string; haystack?: string }>,
  opts?: { labelOnly?: boolean },
): number | null {
  const n = ordinalOrNumber(text);
  if (n != null && n >= 1 && n <= candidates.length) return n - 1;

  let needle = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(the|one|option|number|please|store)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (needle.length < 2) return null;

  const labelOnly = opts?.labelOnly ?? false;
  let best: { i: number; score: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const label = c.label.toLowerCase();
    const hay = labelOnly ? label : `${label} ${c.haystack ?? ""}`.toLowerCase();

    if (label === needle || needle === label) {
      const score = 4;
      if (!best || score > best.score) best = { i, score };
      continue;
    }
    if (needle.includes(label) && label.length >= 3 && needle.length <= label.length + 12) {
      // "the Target one" → needle "target"
      const score = 3.5;
      if (!best || score > best.score) best = { i, score };
      continue;
    }
    if (!labelOnly && hay.includes(needle) && needle.length >= 4) {
      // Full phrase found in title — weak for selection (often a re-search)
      continue;
    }
    if (label.includes(needle) && needle.length >= 3) {
      const score = 3 + needle.length / 20;
      if (!best || score > best.score) best = { i, score };
      continue;
    }
    if (labelOnly) continue;
    const tokens = needle.split(" ").filter((w) => w.length > 2);
    if (!tokens.length) continue;
    // Require a token hit on the store label itself, not only product title
    const labelHits = tokens.filter((w) => label.includes(w)).length;
    if (labelHits === 0) continue;
    const score = labelHits / tokens.length;
    if (!best || score > best.score) best = { i, score };
  }
  return best && best.score >= 0.5 ? best.i : null;
}

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
