/**
 * Answerability / coverage check — the "check before you promise" step from
 * NVIDIA Auto Ontology. Before the shopping agent tells a shopper "I can get
 * that," compose the real checks (compliance eligibility here; merchant
 * payability and trip feasibility via injected ports) and report whether the
 * request is answerable, what's missing, and a next step — instead of
 * hallucinating a match that dies later.
 *
 * Compliance is checked in-package (pure, via @manebra/compliance). The
 * non-pure checks are injected as ports so this stays unit-testable and owns no
 * I/O, exactly like the Vector C ports in @repo/agentcard/commerce.
 */
import { checkItem, type TripDirection } from "@manebra/compliance";

/** What the shopper is asking for, already resolved to canonical terms. */
export type CoverageRequest = {
  /** Canonical category slug from resolveCategory, or null when unresolved. */
  category: string | null;
  /** Store domain from resolveMerchant, or null when unresolved. */
  merchantDomain: string | null;
  /** Canonical corridor from resolveCorridor, or null when unresolved. */
  direction: TripDirection | null;
  /** When the shopper needs it, if given. */
  needBy?: Date | null;
};

/** The non-pure checks the host wires in; omit one to skip that check. */
export type CoveragePorts = {
  /** Can Agentcard pay at this store today? (e.g. GET /buy/merchants) */
  merchantPayable?: (domain: string) => Promise<boolean>;
  /** Is a traveler plausibly heading this way in time? (db/agents peek) */
  feasibleTrip?: (direction: TripDirection, needBy?: Date | null) => Promise<boolean>;
};

export type CoverageGap =
  | "corridor_unresolved"
  | "category_unresolved"
  | "category_not_eligible"
  | "merchant_unresolved"
  | "merchant_not_payable"
  | "no_feasible_trip";

export type TraceStep = { step: string; result: string };

export type CoverageResult = {
  /** True when no blocking gap remains; the agent may offer to proceed. */
  answerable: boolean;
  /** True when an eligible item still needs a customs/compliance review first. */
  requiresReview: boolean;
  /** Blocking and soft gaps, most important first. */
  gaps: CoverageGap[];
  /** One shopper-facing next step, or null when fully answerable. */
  suggestion: string | null;
  /** The resolved terms and check results, to show the shopper ("show the steps"). */
  trace: TraceStep[];
};

const SUGGESTION: Partial<Record<CoverageGap, string>> = {
  corridor_unresolved: "Tell me which country to deliver to so I can route it.",
  category_unresolved: "I need a clearer idea of the item before I can check if it can be carried.",
  category_not_eligible: "That item can't be carried on this route — want me to suggest an alternative?",
  merchant_unresolved: "Which store should I buy it from?",
  merchant_not_payable: "I can't pay at that store yet — want me to try another, like Amazon?",
  no_feasible_trip: "No traveler is heading there in time yet — I can widen the deadline or keep looking.",
};

/**
 * Run the coverage check. Blocking gaps make it unanswerable; a compliance
 * `flag` is a soft gap (answerable, but `requiresReview`).
 */
export async function coverage(req: CoverageRequest, ports: CoveragePorts = {}): Promise<CoverageResult> {
  const gaps: CoverageGap[] = [];
  const trace: TraceStep[] = [];
  let requiresReview = false;

  // 1. Corridor
  if (!req.direction) {
    gaps.push("corridor_unresolved");
    trace.push({ step: "corridor", result: "unresolved" });
  } else {
    trace.push({ step: "corridor", result: req.direction });
  }

  // 2. Category + compliance (only meaningful once we know the direction)
  if (!req.category) {
    gaps.push("category_unresolved");
    trace.push({ step: "category", result: "unresolved" });
  } else if (req.direction) {
    const verdict = checkItem(req.category, req.direction);
    trace.push({ step: "compliance", result: `${req.category}: ${verdict.disposition}` });
    if (verdict.disposition === "deny") gaps.push("category_not_eligible");
    else if (verdict.disposition === "flag") requiresReview = true;
  } else {
    trace.push({ step: "category", result: `${req.category} (corridor needed to check)` });
  }

  // 3. Merchant
  if (!req.merchantDomain) {
    gaps.push("merchant_unresolved");
    trace.push({ step: "merchant", result: "unresolved" });
  } else {
    trace.push({ step: "merchant", result: req.merchantDomain });
    if (ports.merchantPayable) {
      const payable = await ports.merchantPayable(req.merchantDomain);
      trace.push({ step: "merchant_payable", result: payable ? "yes" : "no" });
      if (!payable) gaps.push("merchant_not_payable");
    }
  }

  // 4. Trip feasibility
  if (req.direction && ports.feasibleTrip) {
    const feasible = await ports.feasibleTrip(req.direction, req.needBy ?? null);
    trace.push({ step: "feasible_trip", result: feasible ? "yes" : "no" });
    if (!feasible) gaps.push("no_feasible_trip");
  }

  const answerable = gaps.length === 0;
  const suggestion = answerable ? null : (SUGGESTION[gaps[0]!] ?? null);
  return { answerable, requiresReview, gaps, suggestion, trace };
}
