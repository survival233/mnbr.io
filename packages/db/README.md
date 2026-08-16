# @manebra/db

Owner: **platform** (Prisma schema + marketplace store).

Postgres client and marketplace offers/trips. Shopper and Traveler share one `DATABASE_URL`. Offers stay in this package (one schema) — do not split a `packages/marketplace` until the tables leave Prisma.

## Public API

```ts
import { prisma, writeOffer, updateOffer, getOffer, listOpenOffers, upsertLiveTrip } from "@manebra/db";
```

| Export | Purpose |
|---|---|
| `prisma` | PrismaClient |
| `writeOffer` / `updateOffer` / `getOffer` | Shopper offer row |
| `listOpenOffers` / `latestOpenOffer` / `latestActiveOffer` | Traveler inbox |
| `upsertLiveTrip` / `listLiveTrips` | Live traveler route + date |
| `marketplaceConfigured` | `DATABASE_URL` present |

Local demo without `DATABASE_URL` uses a JSON file (`DEMO_MARKETPLACE_PATH`). Render must set Postgres.
