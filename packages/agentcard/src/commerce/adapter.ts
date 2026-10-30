/**
 * Bridge a Commerce SDK buy turn into Manebra's own OpenAI-protocol tool loop
 * (`chatToolLoop` in `@manebra/llm`). We deliberately return a structural shape
 * — `{ name, description, parameters }` plus `callTool` — rather than importing
 * `@manebra/llm`, so this payment package stays free of a dependency on the
 * conversation layer. The shape matches `LlmToolSpec` by structure.
 *
 * `turn.openai` carries the function schema; `turn.handle(args)` runs the call
 * and returns the model-safe JSON view with every link already taken out (the
 * links reach the shopper through the turn's `sendLink`). So the model never
 * reads or echoes a link, exactly as the SDK intends.
 */
import type { BuyToolTurn } from "@agent-cards/commerce-sdk";

/** Structural match for `@manebra/llm`'s `LlmToolSpec` (no import needed). */
export type LlmToolSpecLike = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type BuyToolBridge = {
  /** Pass inside `tools: [spec]` of `chatToolLoop`. */
  spec: LlmToolSpecLike;
  /** Wire as `callTool`: runs only when the model calls the buy tool by name. */
  callTool: (name: string, input: Record<string, unknown>) => Promise<string>;
};

/**
 * Adapt one buy turn for one actor message. Give the returned `spec`/`callTool`
 * to `chatToolLoop`; after the loop, read `turn.links`, `turn.results` and
 * `turn.messages(history)` to drive the chat and persist history.
 */
export function bridgeBuyTurn(turn: BuyToolTurn): BuyToolBridge {
  const fn = turn.openai.function;
  return {
    spec: {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters as unknown as Record<string, unknown>,
    },
    callTool: async (name, input) => {
      if (name !== fn.name) {
        // Not our tool — let the host loop's other tools handle it.
        return `ERROR: unknown tool ${name}`;
      }
      return turn.handle(input);
    },
  };
}
