import { makeVisionLlm, makeLlm, runCognitiveTurn, type CognitiveTurnResult } from "@manebra/llm";
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

export type PolicyDecision = {
  bubbles: string[];
  /** If set, host should set searchQuery and continue journey (ask city / search). */
  confirmedProduct?: string;
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
    usCity: s.shoppingCity,
    ghCity: s.deliveryCity,
    deadline: s.deadline?.toISOString?.() ?? null,
    maxFeeCents: s.maxFeeCents ?? null,
    step: s.step,
  });
}

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
  const cog = ensureCognition(s);
  const text = args.text.trim();
  const images = args.imageUrls.filter(Boolean);
  const hasMedia = images.length > 0;

  // Affirm pending product without needing LLM
  if (cog.pending?.kind === "confirm_product" && /^(y|yes|ok|okay|sure|yeah|yep|yup)\b/i.test(text) && !hasMedia) {
    const product = cog.pending.hypothesis;
    cog.pending = null;
    cog.persona.beliefs = [...new Set([...cog.persona.beliefs, `wants ${product}`])].slice(-8);
    cog.persona.openQuestions = cog.persona.openQuestions.filter((q) => !/product/i.test(q));
    appendEpisode(cog.memory, "affirm", `Confirmed product ${product}`, { product });
    const ask =
      predictiveAsk({
        product,
        shoppingCity: s.shoppingCity === "New York" ? undefined : s.shoppingCity,
        deliveryCity: s.deliveryCity,
        deadline: s.deadline,
        maxFeeCents: s.maxFeeCents,
        tone: cog.persona.communication,
      }) ?? `Which US city should I shop in for ${product}?`;
    return {
      bubbles: [`Locked in — ${product}.`, ask],
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

  const llm = hasMedia ? makeVisionLlm() : makeLlm();
  if (!llm) {
    if (hasMedia) {
      return {
        bubbles: ["I can see you sent a photo, but vision isn’t configured on my side yet. What product is that?"],
        fallthrough: false,
      };
    }
    return { bubbles: [], fallthrough: true };
  }

  // Always run cognition when images present, or at intake / pending confirm / early steps
  const shouldCognize =
    hasMedia ||
    Boolean(cog.pending) ||
    ["idle", "await_product", "await_product_confirm", "await_shopping_city"].includes(s.step) ||
    process.env.LINQ_COGNITION === "1";

  if (!shouldCognize && !hasMedia) {
    return { bubbles: [], fallthrough: true };
  }

  let turn: CognitiveTurnResult;
  try {
    turn = await withTimeout(
      runCognitiveTurn(llm, {
        text,
        imageUrls: images,
        step: s.step,
        pendingProduct: cog.pending?.hypothesis ?? null,
        entitiesSummary: entitiesSummary(s),
        personaSummary: personaSummary(cog.persona),
        memorySummary: memorySummary(cog.memory),
      }),
      hasMedia ? 8_000 : 5_000,
      "cognitive turn",
    );
  } catch (e: any) {
    console.warn(`[cognition] turn failed: ${e?.message ?? e}`);
    if (hasMedia) {
      return {
        bubbles: ["I’m having trouble reading that photo — what product should I shop for?"],
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
    step: s.step,
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

  // Policy: propose_product must confirm — never search yet
  if (turn.action === "propose_product" && turn.productHypothesis) {
    if (turn.confidence < 0.45) {
      return {
        bubbles: [
          turn.askUser ??
            "I’m not sure what that is — what product should I shop for?",
        ],
        fallthrough: false,
        monologueLog: cog.lastMonologue,
      };
    }
    cog.pending = {
      kind: "confirm_product",
      hypothesis: turn.productHypothesis,
      confidence: turn.confidence,
    };
    s.step = "await_product_confirm";
    const q =
      turn.confirmQuestion ??
      `Looks like ${turn.productHypothesis} — want me to shop that for Ghana hand-delivery?`;
    return { bubbles: [q], fallthrough: false, monologueLog: cog.lastMonologue };
  }

  if (turn.action === "ask_user") {
    const ask =
      turn.askUser ??
      predictiveAsk({
        product: s.searchQuery,
        shoppingCity: s.shoppingCity === "New York" ? undefined : s.shoppingCity,
        deliveryCity: s.deliveryCity,
        deadline: s.deadline,
        maxFeeCents: s.maxFeeCents,
        pendingConfirm: Boolean(cog.pending),
        tone: cog.persona.communication,
      }) ??
      "What should I help you shop for?";
    return { bubbles: [ask], fallthrough: false, monologueLog: cog.lastMonologue };
  }

  if (turn.action === "set_slots") {
    const product =
      turn.slots.product ||
      turn.productHypothesis ||
      (cog.pending?.kind === "confirm_product" ? cog.pending.hypothesis : null);
    if (product && (hasMedia || cog.pending || !s.searchQuery)) {
      // Treat as confirmed if model sets slots with product after image/confirm context
      if (cog.pending || hasMedia || turn.confidence >= 0.7) {
        cog.pending = null;
        const ask =
          turn.proactiveAsk ??
          predictiveAsk({
            product,
            shoppingCity: turn.slots.usCity ?? (s.shoppingCity === "New York" ? undefined : s.shoppingCity),
            deliveryCity: turn.slots.ghCity ?? s.deliveryCity,
            tone: cog.persona.communication,
          });
        return {
          bubbles: ask ? [`Got it — ${product}.`, ask] : [`Got it — ${product}.`],
          confirmedProduct: product,
          applySlots: turn.slots,
          fallthrough: false,
          monologueLog: cog.lastMonologue,
        };
      }
    }
    return {
      bubbles: [],
      applySlots: turn.slots,
      fallthrough: true,
      monologueLog: cog.lastMonologue,
    };
  }

  // search_ok / ack — may fall through to step machine, but still proactive ask if needed
  if (turn.proactiveAsk && ["await_product", "idle"].includes(s.step) && !text) {
    return { bubbles: [turn.proactiveAsk], fallthrough: false };
  }

  return {
    bubbles: [],
    applySlots: turn.slots,
    fallthrough: true,
    monologueLog: cog.lastMonologue,
  };
}
