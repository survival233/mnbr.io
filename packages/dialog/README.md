# @manebra/dialog

Owner: **conversation**.

Shared conversation kernel. Agents register a slot schema only — they do not own voice or turn order.

## Public API

```ts
import {
  classifyTurn,
  persistBeforeAsk,
  composeHostReply,
  HOSPITALITY_PERSONA,
  llmStayBlock,
  SHOPPER_SLOT_SCHEMA,
} from "@manebra/dialog";
```

| Export | Purpose |
|---|---|
| `classifyTurn` | META → REPAIR → CONTINUE → NEW → REASK against persisted state |
| `composeHostReply` | Act-first: acknowledge, then the next step |
| `HOSPITALITY_PERSONA` | Shared host voice ([PERSONA.md](./PERSONA.md)) |
| `llmStayBlock` | Stay + recent turns for every LLM call |
| `persistBeforeAsk` | Flush session before the agent asks |
| `SHOPPER_SLOT_SCHEMA` / `TRAVELER_SLOT_SCHEMA` | What each agent registers |

See [POLICY.md](./POLICY.md).
