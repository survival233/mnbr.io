# Traveler agent

Owner: **traveler**. Flight intake + marketplace accept/decline.

```bash
npm run traveler-agent
# → :8791  GET /health
```

Production: `manebra-traveler-agent` in [`render.yaml`](../../render.yaml). Same Postgres `DATABASE_URL` as Shopper.

Does not import `apps/shopper-agent/src`. Shared dialog is `@manebra/dialog`. Shared offers/trips are `@manebra/db`.

## Connect Calendar (Google)

Phase 0 chat does not require a calendar. In chat, “connect calendar” or “link google” starts Google OAuth. “Set up later” returns to the flight stub or “where you’re headed” path.

Scope is calendar read only (`https://www.googleapis.com/auth/calendar.readonly`). Gmail is not requested. Phone calendar is a stub on this host.

The OAuth URL is built on the server from these env vars. Do not put the secret in a prompt or a client bundle.

| Env | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client |
| `GOOGLE_CLIENT_SECRET` | Token exchange and refresh. Also seals stored tokens when `CALENDAR_TOKEN_KEY` is unset |
| `GOOGLE_REDIRECT_URI` | Callback. Production: `https://manebra-traveler-agent.onrender.com/oauth/google/callback`. Local: `http://127.0.0.1:<PORT>/oauth/google/callback` (`PORT` defaults to 10000) |
| `PUBLIC_BASE_URL` | Used to build the redirect when `GOOGLE_REDIRECT_URI` is unset |
| `CALENDAR_TOKEN_KEY` | Optional 64-char hex key for token encryption at rest |

Register both redirect URIs on the Google client. After consent, Traveler reads confirmed flights once, proposes trips on the marketplace trip store, and waits for an explicit Shop & Deliver opt-in.

How calendar data is kept: [docs/how-we-use-calendar-data.md](docs/how-we-use-calendar-data.md).

Apply the marketplace migration before production sync: `npm run migrate:deploy --workspace @manebra/db`.
