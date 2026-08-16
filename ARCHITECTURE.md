# Manebra architecture

Relay (`relayapp.im`) is the chat window. Do not build a client in this repo.

## Packages and owners

| Path | Owner | Role |
|---|---|---|
| `packages/dialog` | conversation | `classifyTurn`, `persistBeforeAsk`, [POLICY.md](packages/dialog/POLICY.md) |
| `apps/shopper-agent` | shopper | Shopper inbound → match → wait → fund-after-accept |
| `apps/traveler-agent` | traveler | Flights + accept/decline + live trip upsert |
| `apps/agent-cli` | platform | `npm run demo` only |
| `packages/db` | platform | Prisma + `marketplace_offers` / `marketplace_trips` |
| `packages/settlement` | platform | Escrow math + chain (do not rewrite) |
| `packages/llm` | conversation | Intake LLM (do not swap) |
| `packages/agents` | platform | Matching scorer (do not rewrite) |
| `packages/shared` | platform | Fees, handover, dates |
| `packages/catalog` | shopper | Product search |
| `packages/calendar` | traveler | City normalize |
| `packages/flights` | traveler | Flight search/book |

Agents do not import each other’s `src`. Shared conversation is `@manebra/dialog`. Shared jobs are `@manebra/db` (not a second marketplace package).

## Deploy

[`render.yaml`](render.yaml) is the contract:

- `manebra-linq-agent` → `npm run shopper-agent` (hostname stays)
- `manebra-traveler-agent` → `npm run traveler-agent`
- One Postgres `manebra-marketplace` → `DATABASE_URL` on both

## How to run

```bash
npm run demo              # Anvil + escrow + both agents; chat on Relay
npm run shopper-agent     # Shopper only
npm run traveler-agent    # Traveler only
```

Linq Partner API clients (`linq-client.mts`) stay as an optional transport on each agent. They are not the product name.
