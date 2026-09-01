/** Episodic memory, persona (ToM), and conversation cognition types. */

import { EARNINGS_ASK, parseItem } from "@manebra/dialog";

export type CognitiveTopic =
  | "intake"
  | "shopping"
  | "matching"
  | "payment"
  | "handover"
  | "chitchat";

export type PendingConfirm = {
  kind: "confirm_product" | "confirm_listing" | "confirm_pay";
  hypothesis: string;
  confidence: number;
};

export type UserPersona = {
  goals: string[];
  constraints: string[];
  beliefs: string[];
  openQuestions: string[];
  communication: "terse" | "warm" | "formal";
};

export type EpisodeEvent = {
  at: number;
  act: string;
  summary: string;
  entities?: Record<string, string>;
};

export type EpisodicMemory = {
  events: EpisodeEvent[];
  rollingSummary: string;
};

export type CognitionState = {
  topic: CognitiveTopic;
  pending: PendingConfirm | null;
  persona: UserPersona;
  memory: EpisodicMemory;
  lastMonologue?: string;
};

export function blankCognition(): CognitionState {
  return {
    topic: "intake",
    pending: null,
    persona: {
      goals: [],
      constraints: [],
      beliefs: [],
      openQuestions: ["what product they want"],
      communication: "warm",
    },
    memory: { events: [], rollingSummary: "" },
  };
}

export function ensureCognition<T extends { cognition?: CognitionState }>(s: T): CognitionState {
  if (!s.cognition) s.cognition = blankCognition();
  return s.cognition;
}

export function appendEpisode(mem: EpisodicMemory, act: string, summary: string, entities?: Record<string, string>) {
  mem.events.push({ at: Date.now(), act, summary: summary.slice(0, 120), entities });
  if (mem.events.length > 30) mem.events.splice(0, mem.events.length - 30);
  const tail = mem.events
    .slice(-5)
    .map((e) => e.summary)
    .join(" · ");
  mem.rollingSummary = (mem.rollingSummary ? `${mem.rollingSummary} | ${tail}` : tail).slice(-400);
}

export function mergePersona(persona: UserPersona, updates: Partial<UserPersona> & Record<string, unknown>) {
  if (Array.isArray(updates.goals) && updates.goals.length) {
    persona.goals = unique([...persona.goals, ...updates.goals.map(String)]).slice(-8);
  }
  if (Array.isArray(updates.constraints) && updates.constraints.length) {
    persona.constraints = unique([...persona.constraints, ...updates.constraints.map(String)]).slice(-8);
  }
  if (Array.isArray(updates.beliefs) && updates.beliefs.length) {
    persona.beliefs = unique([...persona.beliefs, ...updates.beliefs.map(String)]).slice(-8);
  }
  if (Array.isArray(updates.openQuestions) && updates.openQuestions.length) {
    persona.openQuestions = unique(updates.openQuestions.map(String)).slice(-8);
  }
  if (updates.communication === "terse" || updates.communication === "warm" || updates.communication === "formal") {
    persona.communication = updates.communication;
  }
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

export function personaSummary(p: UserPersona): string {
  return [
    `tone=${p.communication}`,
    p.goals.length ? `goals=${p.goals.join(",")}` : "",
    p.beliefs.length ? `beliefs=${p.beliefs.join(",")}` : "",
    p.constraints.length ? `constraints=${p.constraints.join(",")}` : "",
    p.openQuestions.length ? `open=${p.openQuestions.join(",")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function memorySummary(m: EpisodicMemory): string {
  if (m.rollingSummary) return m.rollingSummary;
  return m.events
    .slice(-5)
    .map((e) => e.summary)
    .join(" · ") || "(empty)";
}

/** Host-side conflict checks before/after cognitive turn. */
export function detectConflicts(args: {
  pendingProduct?: string | null;
  newProduct?: string | null;
  text: string;
  hasImages: boolean;
  step: string;
}): { kind: string; message: string } | null {
  const pending = args.pendingProduct?.toLowerCase();
  const next = args.newProduct?.toLowerCase();
  if (pending && next && pending !== next && !next.includes(pending) && !pending.includes(next)) {
    return {
      kind: "product_clash",
      message: `You were looking at ${args.pendingProduct}, but this looks like ${args.newProduct}.`,
    };
  }
  if (/pay|escrow|fund/i.test(args.text) && ["await_product", "await_shopping_city", "await_listing"].includes(args.step)) {
    return {
      kind: "step_clash",
      message: "We still need to lock the product and traveler before payment.",
    };
  }
  if (args.hasImages && !next && !args.text.trim()) {
    return null; // cognitive layer will ask
  }
  return null;
}

/** Next proactive question from missing journey slots. */
export function predictiveAsk(args: {
  product?: string;
  shoppingCity?: string;
  deliveryCity?: string;
  deadline?: Date;
  maxFeeCents?: number;
  pendingConfirm?: boolean;
  tone?: UserPersona["communication"];
}): string | null {
  if (args.pendingConfirm && args.product) {
    return null; // confirm bubble owns this turn
  }
  const warm = args.tone !== "terse";
  const item = args.product ? parseItem(args.product) : null;
  if (!item) {
    return warm
      ? "What are you looking to buy — or send a photo of the item?"
      : "What product should I shop for?";
  }
  if (!args.deliveryCity) {
    return warm ? "Which city should it land in?" : "Which city should it land in?";
  }
  if (!args.deadline) {
    return warm ? "When do you need it by at most?" : "When do you need it by at most?";
  }
  if (args.maxFeeCents == null) {
    return EARNINGS_ASK;
  }
  return null;
}
