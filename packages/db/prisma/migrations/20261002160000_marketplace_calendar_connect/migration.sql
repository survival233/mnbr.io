-- Calendar proposals live on marketplace_trips (the matching trip store).
-- Manual Phase 0 rows keep external_event_id ''. Several flights can share a traveler.

ALTER TABLE "marketplace_trips" ADD COLUMN IF NOT EXISTS "source" VARCHAR(32) NOT NULL DEFAULT 'manual';
ALTER TABLE "marketplace_trips" ADD COLUMN IF NOT EXISTS "external_event_id" VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE "marketplace_trips" ADD COLUMN IF NOT EXISTS "opted_in_at" TIMESTAMPTZ;
ALTER TABLE "marketplace_trips" ADD COLUMN IF NOT EXISTS "depart_at" TIMESTAMPTZ;
ALTER TABLE "marketplace_trips" ADD COLUMN IF NOT EXISTS "arrive_at" TIMESTAMPTZ;
ALTER TABLE "marketplace_trips" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(64);
ALTER TABLE "marketplace_trips" ADD COLUMN IF NOT EXISTS "retention_until" TIMESTAMPTZ;
ALTER TABLE "marketplace_trips" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS "marketplace_trips_traveler_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_trips_traveler_id_external_event_id_key"
  ON "marketplace_trips"("traveler_id", "external_event_id");
CREATE INDEX IF NOT EXISTS "marketplace_trips_traveler_id_idx" ON "marketplace_trips"("traveler_id");

CREATE TABLE IF NOT EXISTS "marketplace_calendar_links" (
    "traveler_id" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "scopes" VARCHAR(255) NOT NULL DEFAULT 'https://www.googleapis.com/auth/calendar.readonly',
    "token_cipher" TEXT,
    "refresh_cipher" TEXT,
    "expires_at" TIMESTAMPTZ,
    "connected_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_calendar_links_pkey" PRIMARY KEY ("traveler_id")
);
