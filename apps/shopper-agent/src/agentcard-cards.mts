/**
 * AgentCard virtual cards, driven conversationally over MCP.
 * Per-user OAuth tokens ("Connect with AgentCard"); the toolset is whatever
 * tools/list advertises at runtime — forwarded in full, never curated.
 */
import { chatToolLoop, makeCognitiveLlm } from "@manebra/llm";
import {
  callCardTool,
  getOAuthConnection,
  listCardTools,
  oauthConfigured,
  publicBase,
  redactCardContent,
} from "@repo/agentcard";

const CARD_RE =
  /\b(agent\s?card|virtual\s+card|my\s+cards?\b|new\s+card|card\s+(balance|details|limit|number|transactions?)|(create|make|issue|open|close|freeze|cancel)\s+(a\s+|another\s+|my\s+|the\s+)?card|kyc|verify\s+my\s+identity|card\s+approval)\b/i;

/** Card-tools turn? Conservative on purpose — the shopping flow owns everything else. */
export function wantsCardTools(text: string): boolean {
  return CARD_RE.test(text);
}

export function agentcardConnectLink(identity: string): string {
  return `${publicBase()}/api/agentcard/connect?user=${encodeURIComponent(identity)}`;
}

const CARD_SYSTEM = `You are Manebra's card assistant. You manage the user's AgentCard virtual cards through the tools provided — the tools are the source of truth.
Rules:
- ACT immediately. When the user asks for a card, CALL create_card now — never ask "want me to create a card?".
- If a tool result contains approval_required with an approval_id, call approve_request with it, then finish the original action.
- If a tool fails with kyc_required, the USER must verify their own identity conversationally: call start_kyc, then follow its nextStep/missingFields — ask for a photo of their government ID (submit_kyc_document), then any missing fields (submit_kyc_fields), then hand them the verificationUrl for the short browser face scan. Check get_kyc_status once when they say they're done — never loop on start_kyc.
- Never reveal a full card number or CVV unless the user explicitly asked for the card details to pay with.
- Replies are chat messages: short, plain text, no markdown.`;

/**
 * Handle one card-tools turn. `say` is the host flow's reply channel.
 * Not connected yet → hand the user their personal connect link.
 */
export async function handleCardTurn(
  identity: string,
  text: string,
  say: (t: string) => Promise<void>,
): Promise<void> {
  if (!oauthConfigured()) {
    await say("Card features aren’t set up on this server yet — ask the operator to configure AgentCard.");
    return;
  }
  if (!getOAuthConnection(identity)) {
    await say(`Let’s link your AgentCard first: ${agentcardConnectLink(identity)} — then ask me again.`);
    return;
  }
  const cfg = makeCognitiveLlm();
  if (!cfg) {
    await say("I need an LLM configured (OPENAI_API_KEY) to drive card tools.");
    return;
  }
  try {
    const tools = await listCardTools(identity); // full live toolset
    const answer = await chatToolLoop(cfg, {
      system: CARD_SYSTEM,
      user: text,
      tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
      callTool: async (name, input) => {
        console.log(`[shopper-agent] agentcard tool ${name}`); // name only — results may hold PAN/CVV
        return JSON.stringify(await callCardTool(identity, name, input));
      },
      maxSteps: 8,
    });
    await say(answer || "Done.");
  } catch (e: any) {
    console.error(`[shopper-agent] card turn failed: ${redactCardContent(String(e?.message ?? e))}`);
    await say("Something went wrong talking to AgentCard — try that again in a moment.");
  }
}
