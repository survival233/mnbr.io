/**
 * Multimodal + cognitive turn helpers for Manebra shopper.
 * OpenAI chat-completions protocol (vision + JSON).
 */

export interface LlmConfig {
  provider: "openai" | "hf";
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Env var the apiKey was read from — never log apiKey itself. */
  keyEnv: string;
}

function keyPrefix(k: string): string {
  if (k.startsWith("sk-proj-")) return "sk-proj-";
  if (k.startsWith("sk-")) return "sk-";
  return k ? "other" : "none";
}

/** Safe fingerprint: var name, set, length, prefix, last 4. Never the key. */
export function logLlmClient(role: string, cfg: LlmConfig | null): void {
  if (!cfg) {
    console.log(`[llm] ${role} env=none set=no len=0 prefix=none last4=none`);
    return;
  }
  const k = cfg.apiKey ?? "";
  console.log(
    `[llm] ${role} env=${cfg.keyEnv} set=${k ? "yes" : "no"} len=${k.length} prefix=${keyPrefix(k)} last4=${k.slice(-4) || "none"} model=${cfg.model}`,
  );
}

function normalizeApiKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let k = raw.trim().replace(/^["']|["']$/g, "").trim();
  k = k.replace(/^Bearer\s+/i, "").trim();
  return k || undefined;
}

function sanitizeLlmError(text: string): string {
  return text
    .replace(/Incorrect API key provided:[^"\\]*/gi, "Incorrect API key provided: [redacted]")
    .replace(/sk-[a-zA-Z0-9_\-]{8,}/g, "sk-***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}

export function makeLlm(): LlmConfig | null {
  const openaiKey = normalizeApiKey(process.env.OPENAI_API_KEY);
  const hfKey = normalizeApiKey(process.env.HF_TOKEN);
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  const provider =
    explicit === "openai" || explicit === "hf"
      ? explicit
      : openaiKey
        ? "openai"
        : hfKey
          ? "hf"
          : null;
  if (provider === "openai" && openaiKey) {
    return {
      provider,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: openaiKey,
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      keyEnv: "OPENAI_API_KEY",
    };
  }
  if (provider === "hf" && hfKey) {
    return {
      provider,
      baseUrl: process.env.HF_BASE_URL ?? "https://router.huggingface.co/v1",
      apiKey: hfKey,
      model: process.env.HF_MODEL ?? "meta-llama/Llama-3.3-70B-Instruct",
      keyEnv: "HF_TOKEN",
    };
  }
  return null;
}

/** Always OpenAI when a key exists — HF cannot do vision / reliable cognition. */
export function makeOpenAiLlm(model?: string): LlmConfig | null {
  const apiKey = normalizeApiKey(process.env.OPENAI_API_KEY);
  if (!apiKey) return null;
  return {
    provider: "openai",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey,
    model: model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    keyEnv: "OPENAI_API_KEY",
  };
}

/** Conversational cognition: prefer OpenAI even if LLM_PROVIDER=hf. */
let cognitiveClient: LlmConfig | null | undefined;
export function makeCognitiveLlm(): LlmConfig | null {
  if (cognitiveClient === undefined) cognitiveClient = makeOpenAiLlm() ?? makeLlm();
  return cognitiveClient;
}

/** Same apiKey object as cognition; only the model may differ (OPENAI_VISION_MODEL). */
export function makeVisionLlm(): LlmConfig | null {
  const cog = makeCognitiveLlm();
  if (cog?.apiKey) {
    const visionModel = process.env.OPENAI_VISION_MODEL?.trim() || cog.model;
    return { ...cog, apiKey: cog.apiKey, model: visionModel };
  }
  return makeOpenAiLlm(process.env.OPENAI_VISION_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini");
}

async function chatCompletions(cfg: LlmConfig, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = sanitizeLlmError((await res.text()).slice(0, 400));
    if (res.status === 401 || res.status === 403) {
      console.warn(`[llm] ${cfg.keyEnv} ${cfg.provider} ${res.status} body=${raw.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    throw new Error(`${cfg.provider} API ${res.status}: ${raw}`);
  }
  return res.json();
}

function parseJsonContent(txt: string): any {
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`model returned no JSON: ${txt.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

/** One chat call that must return JSON. */
export async function chatJson(cfg: LlmConfig, system: string, user: string): Promise<any> {
  const call = async (withFormat: boolean) => {
    const data = await chatCompletions(cfg, {
      model: cfg.model,
      temperature: 0,
      ...(withFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return parseJsonContent(data.choices?.[0]?.message?.content ?? "");
  };
  try {
    return await call(true);
  } catch (e: any) {
    if (/API 4\d\d/.test(e.message) && !/401|403|429/.test(e.message)) return call(false);
    throw e;
  }
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

/** Multimodal JSON call (OpenAI-style image_url parts). */
export async function chatJsonMultimodal(
  cfg: LlmConfig,
  system: string,
  parts: ContentPart[],
): Promise<any> {
  const call = async (withFormat: boolean) => {
    const data = await chatCompletions(cfg, {
      model: cfg.model,
      temperature: 0,
      ...(withFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: parts },
      ],
    });
    return parseJsonContent(data.choices?.[0]?.message?.content ?? "");
  };
  try {
    return await call(true);
  } catch (e: any) {
    if (/API 4\d\d/.test(e.message) && !/401|403|429/.test(e.message)) return call(false);
    throw e;
  }
}

export const CATEGORIES = [
  "electronics",
  "clothing_shoes",
  "cosmetics_sealed",
  "books_media",
  "food_sealed_nonperishable",
] as const;

export interface ExtractedOrder {
  itemName: string | null;
  shop: string | null;
  city: string | null;
  deadline: string | null;
  itemCostUsd: number | null;
  maxFeeUsd: number | null;
  category: (typeof CATEGORIES)[number] | null;
}

function normalizeExtracted(o: any): ExtractedOrder {
  return {
    itemName: typeof o.itemName === "string" && o.itemName ? o.itemName : null,
    shop: typeof o.shop === "string" && o.shop ? o.shop : null,
    city: typeof o.city === "string" && o.city ? o.city : null,
    deadline: typeof o.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.deadline) ? o.deadline : null,
    itemCostUsd: typeof o.itemCostUsd === "number" && o.itemCostUsd > 0 ? o.itemCostUsd : null,
    maxFeeUsd: typeof o.maxFeeUsd === "number" && o.maxFeeUsd > 0 ? o.maxFeeUsd : null,
    category: (CATEGORIES as readonly string[]).includes(o.category) ? o.category : null,
  };
}

/** Extract a structured order from free text. Never invents values. */
export async function extractOrder(cfg: LlmConfig, text: string): Promise<ExtractedOrder> {
  const today = new Date().toISOString().slice(0, 10);
  const system =
    `You are the order-intake parser for a cross-border shopping platform (items bought in the US, ` +
    `hand-delivered to Ghana by travelers). Today is ${today}. ` +
    `Extract ONLY what the user actually stated from their message into this exact JSON shape:\n` +
    `{"itemName": string|null, "shop": string|null, "city": string|null, "deadline": "YYYY-MM-DD"|null, ` +
    `"itemCostUsd": number|null, "maxFeeUsd": number|null, "category": string|null}\n` +
    `Rules: city is the delivery city in Ghana (if they only say "Ghana", use null). ` +
    `deadline: resolve relative dates against today; if the year is omitted use the next future occurrence. ` +
    `itemCostUsd is the item's purchase price; maxFeeUsd is the maximum delivery/traveler fee they will pay — never confuse the two. ` +
    `category must be one of ${JSON.stringify(CATEGORIES)} judged from the item, or null if unclear. ` +
    `Use null for anything not stated. Reply with the JSON only.`;
  return normalizeExtracted(await chatJson(cfg, system, text));
}

export type CognitiveAction =
  | "propose_product"
  | "ask_user"
  | "set_slots"
  | "search_ok"
  | "ack";

export interface CognitiveTurnResult {
  monologue: {
    observation: string;
    hypothesis: string;
    uncertainty: string;
    next_move: string;
  };
  action: CognitiveAction;
  productHypothesis: string | null;
  confidence: number;
  confirmQuestion: string | null;
  askUser: string | null;
  slots: {
    product?: string | null;
    usCity?: string | null;
    ghCity?: string | null;
    deadline?: string | null;
    maxFeeUsd?: number | null;
    category?: string | null;
  };
  personaUpdates: {
    goals?: string[];
    constraints?: string[];
    beliefs?: string[];
    openQuestions?: string[];
    communication?: "terse" | "warm" | "formal";
  };
  conflict: { kind: string; message: string } | null;
  proactiveAsk: string | null;
  episodeSummaryLine: string;
}

const COGNITIVE_SYSTEM = `You are the cognitive core for Manebra, a US→Ghana hand-delivery shopping agent.
You MUST reply with ONE JSON object only (no markdown) matching this shape:
{
  "monologue": {"observation": string, "hypothesis": string, "uncertainty": string, "next_move": string},
  "action": "propose_product"|"ask_user"|"set_slots"|"search_ok"|"ack",
  "productHypothesis": string|null,
  "confidence": number,
  "confirmQuestion": string|null,
  "askUser": string|null,
  "slots": {"product": string|null, "usCity": string|null, "ghCity": string|null, "deadline": string|null, "maxFeeUsd": number|null, "category": string|null},
  "personaUpdates": {"goals": string[]|null, "constraints": string[]|null, "beliefs": string[]|null, "openQuestions": string[]|null, "communication": "terse"|"warm"|"formal"|null},
  "conflict": {"kind": string, "message": string}|null,
  "proactiveAsk": string|null,
  "episodeSummaryLine": string
}

Rules:
- If the user sent an image of a product, identify it concretely (brand, model, color, size if visible). If confident, action=set_slots with product filled. If unsure, action=ask_user with one clarifying question. Never search the word "image".
- Never invent a product if the image/text is unclear — action=ask_user.
- ghCity = Ghana delivery city; usCity = US shopping city (must be a real US city name like New York, Atlanta — never put questions into slots).
- If the user asks which city is best / for advice, action=ask_user and put a short recommendation in askUser (suggest New York or Atlanta), do NOT set usCity to their question text.
- If user affirms a pending product confirm, action=set_slots with product filled.
- If user changes product mid-flow, set conflict and propose/ask accordingly.
- proactiveAsk = one natural next question for a missing slot (never payment).
- confidence 0..1. category one of ${JSON.stringify(CATEGORIES)} or null.
- Keep confirmQuestion and askUser short, conversational, human.`;

export async function runCognitiveTurn(
  cfg: LlmConfig,
  args: {
    text: string;
    imageUrls: string[];
    step: string;
    pendingProduct?: string | null;
    entitiesSummary: string;
    personaSummary: string;
    memorySummary: string;
    hospitalityPersona?: string;
    stayBlock?: string;
  },
): Promise<CognitiveTurnResult> {
  const userParts: ContentPart[] = [];
  const preamble =
    (args.hospitalityPersona ? `Host voice:\n${args.hospitalityPersona}\n\n` : "") +
    `Journey step: ${args.step}\n` +
    `Pending product confirm: ${args.pendingProduct ?? "none"}\n` +
    `Known entities: ${args.entitiesSummary}\n` +
    `Persona: ${args.personaSummary}\n` +
    `Episodic memory: ${args.memorySummary}\n` +
    (args.stayBlock ? `${args.stayBlock}\n` : "") +
    `User text: ${args.text || "(none — image only)"}\n`;
  userParts.push({ type: "text", text: preamble });
  const imageParts = args.imageUrls.filter(Boolean).slice(0, 3);
  console.log(
    `[llm] vision parts images=${imageParts.length} data=${imageParts.filter((u) => u.startsWith("data:")).length}`,
  );
  for (const url of imageParts) {
    userParts.push({ type: "image_url", image_url: { url, detail: "high" } });
  }

  const o = args.imageUrls.length
    ? await chatJsonMultimodal(cfg, COGNITIVE_SYSTEM, userParts)
    : await chatJson(cfg, COGNITIVE_SYSTEM, preamble);

  const action = (
    ["propose_product", "ask_user", "set_slots", "search_ok", "ack"] as const
  ).includes(o.action)
    ? (o.action as CognitiveAction)
    : "ask_user";

  return {
    monologue: {
      observation: String(o.monologue?.observation ?? ""),
      hypothesis: String(o.monologue?.hypothesis ?? ""),
      uncertainty: String(o.monologue?.uncertainty ?? ""),
      next_move: String(o.monologue?.next_move ?? ""),
    },
    action,
    productHypothesis:
      typeof o.productHypothesis === "string" && o.productHypothesis ? o.productHypothesis : null,
    confidence: typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0.5,
    confirmQuestion:
      typeof o.confirmQuestion === "string" && o.confirmQuestion ? o.confirmQuestion : null,
    askUser: typeof o.askUser === "string" && o.askUser ? o.askUser : null,
    slots: {
      product: o.slots?.product ?? null,
      usCity: o.slots?.usCity ?? null,
      ghCity: o.slots?.ghCity ?? null,
      deadline: o.slots?.deadline ?? null,
      maxFeeUsd: typeof o.slots?.maxFeeUsd === "number" ? o.slots.maxFeeUsd : null,
      category: o.slots?.category ?? null,
    },
    personaUpdates: {
      goals: Array.isArray(o.personaUpdates?.goals) ? o.personaUpdates.goals.map(String) : undefined,
      constraints: Array.isArray(o.personaUpdates?.constraints)
        ? o.personaUpdates.constraints.map(String)
        : undefined,
      beliefs: Array.isArray(o.personaUpdates?.beliefs)
        ? o.personaUpdates.beliefs.map(String)
        : undefined,
      openQuestions: Array.isArray(o.personaUpdates?.openQuestions)
        ? o.personaUpdates.openQuestions.map(String)
        : undefined,
      communication: ["terse", "warm", "formal"].includes(o.personaUpdates?.communication)
        ? o.personaUpdates.communication
        : undefined,
    },
    conflict:
      o.conflict && typeof o.conflict.message === "string"
        ? { kind: String(o.conflict.kind ?? "conflict"), message: o.conflict.message }
        : null,
    proactiveAsk: typeof o.proactiveAsk === "string" && o.proactiveAsk ? o.proactiveAsk : null,
    episodeSummaryLine:
      typeof o.episodeSummaryLine === "string" && o.episodeSummaryLine
        ? o.episodeSummaryLine.slice(0, 120)
        : args.text.slice(0, 120) || "image upload",
  };
}
