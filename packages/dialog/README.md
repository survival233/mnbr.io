# @manebra/dialog

Owner: **conversation**.

Shared turn protocol for Shopper and Traveler. Agents must not keep a local copy of `classifyTurn` or persist-before-ask.

## Public API

```ts
import {
  classifyTurn,
  persistBeforeAsk,
  filledSlotKeys,
  parseDate,
  parseUsdCents,
} from "@manebra/dialog";
```

| Export | Purpose |
|---|---|
| `classifyTurn` | META → REPAIR → CONTINUE → NEW → REASK against persisted state |
| `persistBeforeAsk` | Flush session before the agent asks |
| `parseDate` / `parseUsdCents` / `categoryOf` | Slot parsers used by classify + agents |
| `fuzzyMatchIndex` | Option binding (listings, travelers) |
| `parseUsShoppingCity` | Strict US hub parse |

See [POLICY.md](./POLICY.md).
