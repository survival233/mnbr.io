# Manebra — Architecture

Manebra is a cross-border shopping marketplace (US → Ghana) where **agents
orchestrate and a deterministic kernel computes**. The one rule that shapes
everything: an LLM (or any agent) may decide *what to do next*, but every
number — fees, totals, escrow amounts — is authored by server-side code, and
every fund movement is guarded by policy + cryptography.

## Layout

```text
mnbr.io/
├── apps/                          # things you RUN
│   ├── api/                       # platform backbone: tRPC routers + Inngest jobs
│   │   ├── src/server/routers/    #   bids, settlement, handover, disputes
│   │   └── src/inngest/           #   escrow-release (48h window), reconcile cron, matching sweep
│   ├── agent-cli/                 # conversational shopping agent (npm run agent / npm run demo)
│   └── mcp/                       # MCP server: the platform as tools for any LLM client (npm run mcp)
├── packages/                      # things apps IMPORT
│   ├── shared/                    # THE KERNEL: computeFees, bid state machine, HMAC handover codes
│   ├── db/                        # Prisma schema + client (Postgres)
│   ├── settlement/                # money rails
│   │   ├── src/core/              #   pure: escrow ids/states, EIP-3009, spend policy, units
│   │   ├── src/server/            #   attestor (signs release/refund), wallets, reconciliation
│   │   └── contracts/             #   HandoverEscrow.sol + MockUSDC.sol (Foundry, 21 tests)
│   ├── agents/                    # deterministic agent engines
│   │   ├── src/matching/          #   trip scorer (kernel-mirrored eligibility gates)
│   │   └── src/negotiation/       #   envelope-bounded fee negotiation (EIP-712 signed limits)
│   └── llm/                       # provider-agnostic LLM client (OpenAI + Hugging Face)
└── scripts/                       # smoke-test.mts — full-stack verification (npm run smoke)
```

## The layers, bottom-up

1. **Kernel (`shared`, `settlement/core`)** — pure functions, exhaustively
   unit-tested. Fee math, the bid state machine (who may move a bid to which
   status), handover-code HMAC, escrow state mapping, spend-policy evaluation.
   No I/O, no model, no opinion.

2. **Money rails (`settlement`)** — the `HandoverEscrow` contract holds USDC
   with exactly three possible destinations fixed at open time (traveler,
   treasury, shopper-refund). Funding is gasless (EIP-3009: the shopper's
   agent wallet signs offline; the platform relays and pays gas). Release and
   refund require an attestation signed by the platform's attestor key. The
   reconciliation job continuously compares the DB mirror against chain truth:
   chain wins, anomalies page.

3. **Agent engines (`agents`)** — deterministic, auditable "agents":
   the matching scorer ranks travelers for an item; the negotiation engine
   converges a fee strictly inside both principals' signed envelopes (your max,
   their min — neither side's limit is revealed to the other). An LLM never
   negotiates; it can only trigger these engines.

4. **Platform backbone (`apps/api`)** — tRPC routers wire the layers to the
   database with auth gates (verified users only), and Inngest functions run
   time-based flows: the 48h dispute window before release, the 5-minute
   reconcile cron, the hourly matching sweep.

5. **Traveler calendar sync (`packages/calendar` + `trips` router)** — zero-friction
   trip supply via **two paths** (offer both; many travelers use only one):
   - **Cloud** — `trips.syncCloudCalendar` (Google / Outlook OAuth). Works on any
     device; pulls every calendar on that account.
   - **Device** — `trips.syncDeviceCalendar` (phone iCal / Calendar.app). Covers
     flights added only on the phone that never sync to Google/Outlook. The app
     reads the local calendar with OS permission and posts minimized fields;
     the server cannot reach the phone calendar by itself.
   Both paths parse flights (cities, dates, direction, confidence), reverse-match
   open shopper requests via `proposeMatchesForTrip`, and write `job_alert`
   notifications. Never email bodies, flight numbers, or PNRs. Low-confidence
   parses (`< 0.7`) need `trips.confirmTrip`. Revoke deletes upcoming calendar
   trips with no bids; funded trips are retained for settlement.

6. **Agent surfaces (`apps/agent-cli`, `apps/mcp`)** — where language comes in:
   - `agent-cli` is the interactive terminal agent: with an OpenAI/HF key it
     parses your free-text order live (`packages/llm`), then drives the whole
     pipeline, asking only for decisions that are yours (pick a traveler,
     confirm the handover code, dispute or not).
   - `mcp` exposes the same lifecycle as **Model Context Protocol tools**
     (`setup_marketplace`, `create_item_request`, `find_matches`, `place_bid`,
     `accept_bid`, `fund_bid`, `generate_handover_code`, `confirm_handover`,
     `release_escrow`, `open_dispute_and_refund`, `get_bid`, `reconcile`,
     `platform_status`) so Claude, Cursor, or any MCP client can operate the
     marketplace conversationally. Tools call the real routers — the same
     gates apply to a model as to a human.

## Running things

```bash
npm run demo     # interactive shopping-agent session (alias: npm run agent)
npm run mcp      # MCP server on stdio (plug into Claude Desktop / Cursor)
npm run smoke    # end-to-end verification: routers + DB + chain, happy path + refund
npm test         # unit suites (90 tests)  ·  npm run contracts:test (21 forge tests)
npm run typecheck
```

Local chain: anvil with chain id 84532 (Base Sepolia's id, so all EIP-712
domains match testnet). `agent-cli` and `mcp` auto-start anvil and deploy
`MockUSDC` + `HandoverEscrow` if nothing is configured. For real Base Sepolia,
set `RPC_URL`, `HANDOVER_ESCROW_ADDRESS`, `USDC_ADDRESS`, `ATTESTOR_PRIVATE_KEY`
(see `packages/settlement/DEPLOY.md`; deploy with `OPERATOR` = attestor address).

LLM keys (`apps/agent-cli/.env`, see `.env.example`): `OPENAI_API_KEY` and/or
`HF_TOKEN`, choose with `LLM_PROVIDER=openai|hf`.

## Shopper product → traveler job flow

**Live prices from verified stores — without each store's API.**
`items.search` queries Google Shopping via SerpAPI, keeps only Apple / Best Buy /
Walmart / Target / Amazon, and returns live title, price, URL, image, availability.
`SERPAPI_API_KEY` is required for search (not Apple/BestBuy/Walmart keys). Dummy
catalog data has been removed. Shoppers can still paste a link via `createManual`.

1. `items.search` → live multi-store listings → shopper picks one → `createFromListing`
2. Or `items.createManual` with store/title/price/URL they already have
3. Matching travelers get job alerts (`matches.myJobs`) with Accept / Decline
4. `matches.accept` — **Traveler Accepted**, notify shopper
5. Shopper pays via `bids.accept` + `settlement.fundBid` → **Payment Confirmed**
6. Traveler purchases → bid status updates

## What is real vs seeded (current state)

- **Real & live:** money math, matching, negotiation, escrow, LLM intake,
  shopping request create, traveler accept/decline, **live product search**
  (with `SERPAPI_API_KEY`).
- **Seeded/stand-ins:** marketplace users (until real signups), purchase/transit
  routers (`advance_to_arrived` stands in), Supabase auth, 48h release wait.
