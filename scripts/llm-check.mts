// throwaway: verify live LLM intake for each configured provider
import { readFileSync } from "node:fs";
import { makeLlm, extractOrder } from "@manebra/llm";

for (const line of readFileSync(new URL("../apps/agent-cli/.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim();
}

const SAMPLE = "shop an iPhone 16 Pro from apple.com, deliver to Accra by 15th August, it costs $999, I'll pay up to $30 delivery fee";

for (const provider of ["openai", "hf"] as const) {
  process.env.LLM_PROVIDER = provider;
  const cfg = makeLlm();
  if (!cfg) { console.log(`${provider}: no key configured`); continue; }
  try {
    const t0 = Date.now();
    const o = await extractOrder(cfg, SAMPLE);
    console.log(`${provider} (${cfg.model}) OK in ${Date.now() - t0}ms:`, JSON.stringify(o));
  } catch (e: any) {
    console.log(`${provider} (${cfg.model}) FAILED: ${e.message}`);
  }
}
