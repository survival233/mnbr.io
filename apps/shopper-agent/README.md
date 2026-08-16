# Shopper agent

Owner: **shopper**. Relay is the chat surface (`npm run demo` or `npm run shopper-agent`).

Production Relay still points at `https://manebra-linq-agent.onrender.com` until that Render hostname is cut over. The process is `apps/shopper-agent`; start command is `npm run shopper-agent`.

Shopper journey: product → listing → city/deadline/fee → match traveler → **optional escrow** (test USDC).

## Run

```bash
cp apps/shopper-agent/.env.example apps/shopper-agent/.env
# SERPAPI_API_KEY=…  OPENAI_API_KEY or HF_TOKEN
npm run shopper-agent
# → :8790  GET /health
```

Sessions persist to `apps/shopper-agent/.sessions.json` (override with `SHOPPER_SESSIONS_PATH`).

## Settlement (testnet escrow)

Off by default. When `SETTLEMENT_ENABLED=1` and `apps/api/.env` has chain config:

1. After traveler pick → “YOU PAY ~$X (test USDC). Reply YES”
2. Agent opens escrow + funds with provisioned test USDC
3. Handover code → shopper replies **DONE** → confirm + release

```bash
# in apps/shopper-agent/.env:
# SETTLEMENT_ENABLED=1
npm run shopper-agent
```

Without `SETTLEMENT_ENABLED`, the agent stops at fee preview (conversation-only).

## Production

Blueprint: [`render.yaml`](../../render.yaml) — service name `manebra-linq-agent` (hostname stays). Start: `npm run shopper-agent`. Shared Postgres `DATABASE_URL` with Traveler.

## Out of scope

Traveler flights, fiat on-ramp / Stripe, mainnet, chat UI.
