# MANEBRA architecture

Relay (`relayapp.im`) is the user-facing test surface. There is no `apps/app` shell and no `packages/channels` package — do not invent them.

## Current → target

| Target layer | Existing location | Action |
|---|---|---|
| App shell | None. Test UI is Relay | Do not build a Manebra client |
| Shopper agent | `apps/shopper-agent` (`shopper-flow.mts`) | Keep. Local inbound is Relay long-poll (`GET /v1/events`) |
| Traveler agent | `apps/traveler-agent` (`traveler-flow.mts`) | Keep flight flow. Demo adds pending-carry / handover |
| Marketplace | `packages/agents` matching + `apps/shopper-agent/src/traveler-seeds.mts` | Keep. Demo writes a shared carry file only |
| Escrow | `packages/settlement` + Anvil deploy in `apps/agent-cli` | Keep both. Demo reuses the CLI open/fund/release against the just-deployed contracts. `settlement-bridge.mts` (Postgres/tRPC) is unchanged |
| Channels | `linq-client.mts` + `relay-client.mts` in each agent | Demo long-polls Relay only. Linq HTTP + `demo:linq` stay as an optional harness |

## How to run

```bash
npm run demo          # boot Anvil + USDC + HandoverEscrow + Ama/Kofi/Nana, start both agents, stay up
# then open Relay and chat Shopper / Traveler
```

Harnesses (not the product path):

```bash
npm run demo:cli      # old interactive terminal pipeline
npm run demo:linq     # same pipeline over iMessage via Linq CLI
DEMO_AUTO=1 npm run demo   # non-interactive CLI defaults
```

Linq/iMessage is not on the product path. `npm run demo` never starts a Linq webhook, never texts a phone, and never waits on iMessage. Chat is Relay only. `demo:linq` remains an optional harness.

Production Relay still points at `https://manebra-linq-agent.onrender.com` until that Render service is renamed/redeployed. Local `render.yaml` names the shopper service `manebra-shopper-agent`.

## Happy path (no phone)

1. `npm run demo` — engines stay up in the terminal
2. Open Relay
3. Chat Shopper (“get me X from the US”)
4. Shopper matches a seeded traveler (Ama / Kofi / Nana), escrow locks on the local chain
5. Chat Traveler to accept / confirm handover
6. Escrow releases
