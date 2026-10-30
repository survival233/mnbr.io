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

## Shared Relay groups

In group chats, start with `@shopper buy …` or `@traveler …` to select an agent.
Short follow-up replies stay with that agent for that participant. Switching agents
preserves each agent's own session. Sessions are isolated by participant and chat;
existing saved sessions migrate on load. Messages marked as bot/agent or outbound
are ignored. Direct chats retain the receiving agent's normal behavior.

When Relay includes `chat.type: group`, `chat.kind: group`, `chat.is_group`, or a
participant list, routing is automatic. If your webhook only supplies a chat ID,
set the same comma-separated `RELAY_SHARED_CHAT_IDS` on **both** services. This is
necessary to distinguish that payload from a direct chat. The initial unaddressed
group message selects Shopper, or Traveler for an explicit flight/travel request.
After selection, use the name prefix to switch. Selection is saved in each app's
ignored `.relay-routing.json`; retain that file alongside the session store.
`SHOPPER_RELAY_ROUTING_PATH` and `TRAVELER_RELAY_ROUTING_PATH` override those paths.

## Delivery dates and payment recovery

Date questions show a text calendar. Reply with a day number, `next month`, or
`previous month`, or type a full date. A day number selects the displayed month.
This uses ordinary Relay text messages; it does not require a native date widget.

Recap confirmation validates the shown total before opening a wallet/pay sheet.
Ordinary replies reuse the current wallet link. Failed pay-sheet creation waits
at least 60 seconds before retrying and does not automatically replace the wallet
link or reset payment identity. Background sync cannot start funding before recap
consent. A successful payment webhook is still required to mark an order funded.
