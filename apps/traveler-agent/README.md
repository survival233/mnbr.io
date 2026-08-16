# Traveler agent

Owner: **traveler**. Flight intake + marketplace accept/decline.

```bash
npm run traveler-agent
# → :8791  GET /health
```

Production: `manebra-traveler-agent` in [`render.yaml`](../../render.yaml). Same Postgres `DATABASE_URL` as Shopper.

Does not import `apps/shopper-agent/src`. Shared dialog is `@manebra/dialog`. Shared offers/trips are `@manebra/db`.
