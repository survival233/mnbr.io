import {
  makeVisionLlm,
  makeCognitiveLlm,
  logLlmClient,
  runCognitiveTurn,
  type CognitiveTurnResult,
} from "@manebra/llm";
import type { Session } from "../session.mts";
import {
  appendEpisode,
  detectConflicts,
  ensureCognition,
  memorySummary,
  mergePersona,
  personaSummary,
  predictiveAsk,
} from "./state.mts";
import { HOSPITALITY_PERSONA, llmStayBlock, parseItem, parseShopPlace } from "@manebra/dialog";

export type PolicyDecision = {
  bubbles: string[];
  /** If set, host should set searchQuery and continue journey (ask city / search). */
  confirmedProduct?: string;
  /** Validated US shopping city — host should search. */
  confirmedUsCity?: string;
  /** If set, apply slot fills without confirming. */
  applySlots?: CognitiveTurnResult["slots"];
  /** Skip cognitive search; continue normal step machine with text. */
  fallthrough: boolean;
  monologueLog?: string;
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function entitiesSummary(s: Session): string {
  return JSON.stringify({
    product: s.searchQuery ?? s.cognition?.pending?.hypothesis ?? null,
    usCity: s.shoppingCity?.trim() ? s.shoppingCity : null,
    deliveryCity: s.deliveryCity,
    deadline: s.deadline?.toISOString?.() ?? null,
    maxFeeCents: s.maxFeeCents ?? null,
    step: s.step,
    form: {
      searchQuery: s.searchQuery ?? null,
      shoppingCity: s.shoppingCity,
      deliveryCity: s.deliveryCity ?? null,
      deadline: s.deadline?.toISOString?.() ?? null,
      maxFeeCents: s.maxFeeCents ?? null,
    },
    pending: s.pending ?? s.offer ?? null,
  });
}

const JOURNEY_STEPS = new Set([
  "idle",
  "await_product",
  "await_product_confirm",
  "await_shopping_city",
  "await_listing",
  "await_delivery_city",
  "await_deadline",
  "await_max_fee",
  "await_extend",
  "await_traveler",
]);

/**
 * Run multimodal cognition + host policy.
 * Returns forced interactive bubbles and/or instructions to continue the journey.
 */
export async function runPolicyTurn(args: {
  session: Session;
  text: string;
  imageUrls: string[];
}): Promise<PolicyDecision> {
  const s = args.session;
  const step = s.step;
  const cog = ensureCognition(s);
  const text = args.text.trim();
  const images = args.imageUrls.filter(Boolean);
  const hasMedia = images.length > 0;

  // Affirm pending product without needing LLM
  if (cog.pending?.kind === "confirm_product" && /^(y|yes|ok|okay|sure|yeah|yep|yup)\b/i.test(text) && !hasMedia) {
    const product = parseItem(cog.pending.hypothesis);
    if (!product) {
      cog.pending = null;
      return {
        bubbles: ["What product should I shop for?"],
        fallthrough: false,
      };
    }
    cog.pending = null;
    return {
      bubbles: [],
      confirmedProduct: product,
      fallthrough: false,
    };
  }

  // Soft reject of pending
  if (cog.pending?.kind === "confirm_product" && /^(n|no|nope|nah|wrong)\b/i.test(text) && !hasMedia) {
    cog.pending = null;
    appendEpisode(cog.memory, "reject", "Rejected product hypothesis");
    return {
      bubbles: ["No problem — what should I look for instead? (text or photo)"],
      fallthrough: false,
    };
  }

  // Leftover shopping-city step: catalog is national — host searches.
  if (step === "await_shopping_city" && text && !hasMedia) {
    return { bubbles: [], fallthrough: true };
  }

  const llm = hasMedia ? makeVisionLlm() : makeCognitiveLlm();
  logLlmClient(hasMedia ? "vision" : "cognition", llm);
  if (!llm) {
    if (hasMedia) {
      return {
        bubbles: [
          "I can see you sent a photo, but vision isn’t configured (need OPENAI_API_KEY). What product is that?",
        ],
        fallthrough: false,
      };
    }
    if (step === "await_shopping_city" && text) {
      return { bubbles: [], fallthrough: true };
    }
    return { bubbles: [], fallthrough: true };
  }

  if (!hasMedia && !JOURNEY_STEPS.has(step) && process.env.LINQ_COGNITION !== "1") {
    return { bubbles: [], fallthrough: true };
  }

  let turn: CognitiveTurnResult;
  try {
    turn = await withTimeout(
      runCognitiveTurn(llm, {
        text,
        imageUrls: images,
        step,
        pendingProduct: cog.pending?.hypothesis ?? null,
        entitiesSummary: entitiesSummary(s),
        personaSummary: personaSummary(cog.persona),
        memorySummary: memorySummary(cog.memory),
        hospitalityPersona: HOSPITALITY_PERSONA,
        stayBlock: llmStayBlock(s.stay, s.turns),
      }),
      hasMedia ? 12_000 : 8_000,
      "cognitive turn",
    );
  } catch (e: any) {
    const err = String(e?.message ?? e);
    console.warn(`[cognition] turn failed: ${err.slice(0, 180)}`);
    if (hasMedia) {
      if (/API 401|API 403|invalid_api_key/i.test(err)) {
        return {
          bubbles: ["I can see the photo, but I can’t identify products right now — type the item?"],
          fallthrough: false,
        };
      }
      return {
        bubbles: ["I’m having trouble reading that photo — what product should I shop for?"],
        fallthrough: false,
      };
    }
    if (step === "await_shopping_city") {
      return { bubbles: [], fallthrough: true };
    }
    // Do not blindly fall through on mid-conversation clarifies
    if (text.includes("?") || /^(which|what|why|how|should)\b/i.test(text)) {
      return {
        bubbles: [
          predictiveAsk({
            product: s.searchQuery,
            shoppingCity: s.shoppingCity?.trim() || undefined,
            deliveryCity: s.deliveryCity,
            deadline: s.deadline,
            maxFeeCents: s.maxFeeCents,
            tone: cog.persona.communication,
          }) ?? "Happy to help — what should we lock next?",
        ],
        fallthrough: false,
      };
    }
    return { bubbles: [], fallthrough: true };
  }

  if (process.env.DEBUG_MONOLOGUE === "1") {
    console.log(`[monologue] ${JSON.stringify(turn.monologue)}`);
  }
  cog.lastMonologue = JSON.stringify(turn.monologue);
  mergePersona(cog.persona, turn.personaUpdates as any);
  appendEpisode(cog.memory, hasMedia ? "image_upload" : "message", turn.episodeSummaryLine);

  const hostConflict = detectConflicts({
    pendingProduct: cog.pending?.hypothesis,
    newProduct: turn.productHypothesis,
    text,
    hasImages: hasMedia,
    step,
  });
  const conflict = hostConflict ?? turn.conflict;

  // Policy: conflict → repair bubble
  if (conflict && (hasMedia || turn.action === "propose_product")) {
    const hyp = turn.productHypothesis ?? "that item";
    cog.pending = {
      kind: "confirm_product",
      hypothesis: hyp,
      confidence: turn.confidence,
    };
    s.step = "await_product_confirm";
    return {
      bubbles: [
        conflict.message,
        turn.confirmQuestion ?? `Want me to shop for ${hyp} instead?`,
      ],
      fallthrough: false,
      monologueLog: cog.lastMonologue,
    };
  }

  // Photo inbound: name the item and search (same path as typed text). Confirm only if unsure.
  if (hasMedia && turn.productHypothesis) {
    if (turn.confidence < 0.45) {
      return {
        bubbles: [
          turn.askUser ??
            turn.confirmQuestion ??
            `I think it might be ${turn.productHypothesis} — what should I shop for?`,
        ],
        fallthrough: false,
        monologueLog: cog.lastMonologue,
      };
    }
    cog.pending = null;
    return {
      bubbles: [],
      confirmedProduct: turn.productHypothesis,
      applySlots: { ...turn.slots, product: turn.productHypothesis },
      fallthrough: false,
      monologueLog: cog.lastMonologue,
    };
  }

  // Named product: search immediately. Do not park a yes-to-search gate.
  if (turn.action === "propose_product" && turn.productHypothesis) {
    if (turn.confidence < 0.45) {
      return {
        bubbles: [
          turn.askUser ?? "I’m not sure what that is — what product should I shop for?",
        ],
        fallthrough: false,
        monologueLog: cog.lastMonologue,
      };
    }
    cog.pending = null;
    return {
      bubbles: [],
      confirmedProduct: turn.productHypothesis,
      applySlots: { ...turn.slots, product: turn.productHypothesis },
      fallthrough: false,
      monologueLog: cog.lastMonologue,
    };
  }

  if (turn.action === "ask_user") {
    // If model tried to stuff a non-city into usCity, ignore it
    const slotCity = turn.slots.usCity ? parseShopPlace(turn.slots.usCity) : null;
    const ask =
      turn.askUser ??
      predictiveAsk({
        product: s.searchQuery,
        shoppingCity: step === "await_shopping_city" ? undefined : s.shoppingCity?.trim() || undefined,
        deliveryCity: s.deliveryCity,
        deadline: s.deadline,
        maxFeeCents: s.maxFeeCents,
        pendingConfirm: Boolean(cog.pending),
        tone: cog.persona.communication,
      }) ??
      "What should I help you shop for?";
    return {
      bubbles: [ask],
      applySlots: slotCity ? { ...turn.slots, usCity: slotCity } : { ...turn.slots, usCity: null },
      fallthrough: false,
      monologueLog: cog.lastMonologue,
    };
  }

  if (turn.action === "set_slots") {
    const rawProduct =
      turn.slots.product ||
      turn.productHypothesis ||
      (cog.pending?.kind === "confirm_product" ? cog.pending.hypothesis : null);
    const product = rawProduct ? parseItem(rawProduct) : null;

    const usCity = turn.slots.usCity ? parseShopPlace(turn.slots.usCity) : null;
    const safeSlots = { ...turn.slots, usCity };

    if (step === "await_shopping_city" && usCity) {
      return {
        bubbles: turn.askUser ? [turn.askUser] : [],
        confirmedUsCity: usCity,
        applySlots: safeSlots,
        fallthrough: false,
        monologueLog: cog.lastMonologue,
      };
    }

    if (product && (hasMedia || cog.pending || !s.searchQuery)) {
      if (cog.pending || hasMedia || turn.confidence >= 0.7) {
        cog.pending = null;
        return {
          bubbles: [],
          confirmedProduct: product,
          applySlots: safeSlots,
          confirmedUsCity: usCity ?? undefined,
          fallthrough: false,
          monologueLog: cog.lastMonologue,
        };
      }
    }
    return {
      bubbles: turn.askUser ? [turn.askUser] : [],
      applySlots: safeSlots,
      fallthrough: !turn.askUser,
      monologueLog: cog.lastMonologue,
    };
  }

  // search_ok / ack
  if (turn.proactiveAsk && ["await_product", "idle"].includes(step)) {
    return { bubbles: [turn.proactiveAsk], fallthrough: false };
  }

  if (step === "await_shopping_city") {
    return {
      bubbles: [],
      fallthrough: true,
      monologueLog: cog.lastMonologue,
    };
  }

  return {
    bubbles: [],
    applySlots: turn.slots,
    fallthrough: true,
    monologueLog: cog.lastMonologue,
  };
}
