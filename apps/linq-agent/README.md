# Manebra Linq Agent — always-on iMessage shopper

Testers **only open Messages**. They do not run `npm run demo` or `demo:linq`.
You (or Render) run this service; it receives Linq webhooks and replies.

Shopper journey: product → listing → city/deadline/fee → match traveler → **optional escrow** (test USDC).

## Settlement (testnet escrow)

Off by default. When `SETTLEMENT_ENABLED=1` and [`apps/api/.env`](../api/.env) has chain config:

1. After traveler pick → “YOU PAY ~$X (test USDC). Reply YES”
2. Agent opens escrow + funds with provisioned test USDC (gasless)
3. Texts handover code → shopper replies **DONE** → confirm + beta immediate release

```bash
# Local sandbox (Anvil :8545 already deployed — see apps/api/.env)
npm run seed:linq-travelers
# in apps/linq-agent/.env:
# SETTLEMENT_ENABLED=1
npm run linq-agent
```

**Base Sepolia (public):** fund deployer/operator/attestor ETH + Circle faucet USDC, then:

```bash
bash scripts/deploy-sepolia.sh
# copy address into apps/api/.env from apps/api/.env.sepolia.example
# SMOKE_USDC_MODE=transfer  USDC_FUNDER_PRIVATE_KEY=…
npm run smoke   # optional verify
```

Without `SETTLEMENT_ENABLED`, the agent stops at fee preview (conversation-only).

## What testers experience

1. You add their number (Shared Line invite)
2. They text `hi` to `+12053968556` (or your share link)
3. Agent: “What should I shop for you?”
4. They finish the flow in Messages — **no repo, no Node, no demo command**

## Invite a tester (Shared Line — once per number)

```bash
linq contacts add +1THEIRNUMBER
```

Share link (replace THEIRNUMBER):

```
https://linqapp.com/s/text/%2B12053968556?from=%2B1THEIRNUMBER&msg=hi
```

They must text first (inbound-first on free Shared Line). After that they just converse.

## Local run (you are the host)

```bash
# 1. Env
cp apps/linq-agent/.env.example apps/linq-agent/.env
# LINQ_API_KEY=$(linq tokens show)   # paste the UUID token
# LINQ_FROM_PHONE=+12053968556
# SERPAPI_API_KEY=…  HF_TOKEN or OPENAI_API_KEY
# (missing keys also fall back to apps/agent-cli/.env)

# 2. Start agent
npm run linq-agent
# → listening on :8790   GET /health

# 3. Forward Linq events (second terminal) — local only
linq webhooks listen --events message.received \
  --forward-to http://127.0.0.1:8790/webhooks/linq?version=2026-02-03
```

Then text the Linq Number from an allowed contact.

## Production (always-on) — permanent webhook

### 1. Deploy

Blueprint: [`render.yaml`](../../render.yaml) (service `manebra-linq-agent`).

Or create a Render **Web Service** manually:

| Setting | Value |
|--------|--------|
| Build | `npm install` |
| Start | `npm run linq-agent` |
| Health | `/health` |
| Env | see below |

**Required env**

| Key | Notes |
|-----|--------|
| `LINQ_API_KEY` | `linq tokens show` |
| `LINQ_FROM_PHONE` | `+12053968556` |
| `LINQ_WEBHOOK_SECRET` | from webhook create (below) |
| `SERPAPI_API_KEY` | shopping search |
| `HF_TOKEN` or `OPENAI_API_KEY` | order extraction |
| `LLM_PROVIDER` | e.g. `hf` |
| `PORT` | set by Render automatically |
| `SETTLEMENT_ENABLED` | `1` when escrow should run |

Push this monorepo to a Git host Render can clone, then deploy. Confirm `https://YOUR_HOST/health` returns `{"status":"ok",…}`.

### 2. Permanent Linq webhook

Stop relying on `linq webhooks listen` on a laptop. Create (or update) a subscription:

```bash
linq webhooks create \
  --url "https://YOUR_HOST/webhooks/linq?version=2026-02-03" \
  --events message.received \
  --json
```

Save the signing secret from the response as `LINQ_WEBHOOK_SECRET` on the service and redeploy if needed.

### 3. What you still operate

- Keep the agent service healthy
- Add Shared Line contacts for new testers
- Secrets + Base Sepolia / Postgres when money path is on

## Health

`GET /health` → service status plus activity:

```json
{
  "service": "manebra-linq-agent",
  "status": "ok",
  "uptimeSec": 120,
  "lastInboundAt": "…",
  "lastActivityAt": "…",
  "sessions": 2,
  "inboundCount": 14
}
```

Sessions persist to `apps/linq-agent/.sessions.json` (override with `LINQ_SESSIONS_PATH`).

## Conversational corrections

On listings, testers can:

- Pick by number **or store name** (“Target”)
- Say **wrong** / **not these** / **try again** → re-ask product
- Type a **new product** (“AirPods Pro 2”) → re-search without restarting

## Webhook hygiene

Laptop `linq webhooks listen` drops and stale relays cause “hi does nothing”. Clean up:

```bash
bash apps/linq-agent/scripts/webhook-hygiene.sh
bash apps/linq-agent/scripts/webhook-hygiene.sh --delete-localhost
```

Then create **one** permanent webhook to the hosted agent URL (see Production above).

## Out of scope (this service)

Traveler calendar + job YES/NO in iMessage, mobile apps, fiat on-ramp / Stripe, mainnet.
