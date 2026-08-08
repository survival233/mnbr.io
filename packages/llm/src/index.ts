/**
 * Provider-agnostic LLM client for the demo intake.
 * OpenAI and Hugging Face both expose the OpenAI chat-completions protocol,
 * so one client covers both — pick via env:
 *
 *   OPENAI_API_KEY=sk-…        (provider auto-selects openai)
 *   HF_TOKEN=hf_…              (provider auto-selects hf)
 *   LLM_PROVIDER=openai|hf     (explicit choice when both keys are set)
 *   OPENAI_MODEL / HF_MODEL    (optional model overrides)
 */

export interface LlmConfig {
  provider: "openai" | "hf";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function makeLlm(): LlmConfig | null {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  const provider =
    explicit === "openai" || explicit === "hf"
      ? explicit
      : process.env.OPENAI_API_KEY ? "openai"
      : process.env.HF_TOKEN ? "hf"
      : null;
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return {
      provider,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    };
  }
  if (provider === "hf" && process.env.HF_TOKEN) {
    return {
      provider,
      baseUrl: process.env.HF_BASE_URL ?? "https://router.huggingface.co/v1",
      apiKey: process.env.HF_TOKEN,
      model: process.env.HF_MODEL ?? "meta-llama/Llama-3.3-70B-Instruct",
    };
  }
  return null;
}

/** One chat call that must return JSON. Retries once without response_format
 *  (some HF router models reject it) and tolerates ```json fences. */
export async function chatJson(cfg: LlmConfig, system: string, user: string): Promise<any> {
  const call = async (withFormat: boolean) => {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        ...(withFormat ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`${cfg.provider} API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };

  let data;
  try {
    data = await call(true);
  } catch (e: any) {
    if (/API 4\d\d/.test(e.message) && !/401|403|429/.test(e.message)) data = await call(false);
    else throw e;
  }
  const txt: string = data.choices?.[0]?.message?.content ?? "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`model returned no JSON: ${txt.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

export const CATEGORIES = [
  "electronics", "clothing_shoes", "cosmetics_sealed", "books_media", "food_sealed_nonperishable",
] as const;

export interface ExtractedOrder {
  itemName: string | null;
  shop: string | null;
  city: string | null;
  deadline: string | null; // YYYY-MM-DD
  itemCostUsd: number | null;
  maxFeeUsd: number | null;
  category: (typeof CATEGORIES)[number] | null;
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
  const o = await chatJson(cfg, system, text);
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
