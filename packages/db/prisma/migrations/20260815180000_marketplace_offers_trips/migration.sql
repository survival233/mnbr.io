-- Relay marketplace: shopper offers + traveler trips (string identities).
-- Shared Postgres for shopper-agent and traveler-agent. Not a local JSON file.

CREATE TABLE IF NOT EXISTS "marketplace_offers" (
    "id" VARCHAR(128) NOT NULL,
    "traveler_id" VARCHAR(128) NOT NULL,
    "traveler_name" VARCHAR(255) NOT NULL,
    "item" VARCHAR(255) NOT NULL,
    "item_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "traveler_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "need_by" TIMESTAMPTZ,
    "destination_city" VARCHAR(100),
    "bid_id" VARCHAR(128) NOT NULL DEFAULT '',
    "escrow_id" VARCHAR(128) NOT NULL DEFAULT '',
    "handover_code" VARCHAR(32) NOT NULL DEFAULT '',
    "status" VARCHAR(32) NOT NULL DEFAULT 'offered',
    "shopper_key" VARCHAR(255),
    "shopper_chat_id" VARCHAR(255),
    "notified_shopper" BOOLEAN NOT NULL DEFAULT false,
    "notified_traveler" BOOLEAN NOT NULL DEFAULT false,
    "notified_traveler_funded" BOOLEAN NOT NULL DEFAULT false,
    "next_traveler_id" VARCHAR(128),
    "next_traveler_name" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_offers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "marketplace_offers_status_created_at_idx" ON "marketplace_offers"("status", "created_at");
CREATE INDEX IF NOT EXISTS "marketplace_offers_traveler_id_status_idx" ON "marketplace_offers"("traveler_id", "status");

CREATE TABLE IF NOT EXISTS "marketplace_trips" (
    "id" UUID NOT NULL,
    "traveler_id" VARCHAR(128) NOT NULL,
    "traveler_name" VARCHAR(255) NOT NULL,
    "origin_city" VARCHAR(100) NOT NULL DEFAULT '',
    "destination_city" VARCHAR(100) NOT NULL,
    "departure_date" DATE NOT NULL,
    "opted_in" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(32) NOT NULL DEFAULT 'upcoming',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_trips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_trips_traveler_id_key" ON "marketplace_trips"("traveler_id");
CREATE INDEX IF NOT EXISTS "marketplace_trips_opted_in_destination_city_departure_date_idx" ON "marketplace_trips"("opted_in", "destination_city", "departure_date");

-- Stale demo carries must not surface as live jobs.
UPDATE "marketplace_offers"
SET "status" = 'declined', "updated_at" = CURRENT_TIMESTAMP
WHERE "status" = 'offered' AND ("item" ILIKE '%AirPods%' OR "item" ILIKE '%sealed electronics parcel%');
