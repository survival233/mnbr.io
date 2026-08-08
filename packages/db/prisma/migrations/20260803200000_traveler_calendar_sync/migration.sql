-- CreateEnum
CREATE TYPE "TripSource" AS ENUM ('manual', 'calendar', 'barcode', 'share_sheet', 'forwarded_email');

-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('apple', 'google', 'outlook', 'android');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('job_alert', 'match_proposed', 'negotiation_agreed', 'system');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'delivered', 'dismissed', 'failed');

-- AlterTable
ALTER TABLE "traveler_trips" ADD COLUMN     "calendar_provider" "CalendarProvider",
ADD COLUMN     "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN     "external_event_id" VARCHAR(255),
ADD COLUMN     "source" "TripSource" NOT NULL DEFAULT 'manual',
ADD COLUMN     "synced_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "CalendarProvider" NOT NULL,
    "token_cipher" TEXT,
    "calendar_id" VARCHAR(255),
    "sync_cursor" VARCHAR(512),
    "last_synced_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_connections_user_id_idx" ON "calendar_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_user_id_provider_key" ON "calendar_connections"("user_id", "provider");

-- CreateIndex
CREATE INDEX "notifications_user_id_status_created_at_idx" ON "notifications"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "traveler_trips_direction_destination_city_departure_date_idx" ON "traveler_trips"("direction", "destination_city", "departure_date");

-- CreateIndex
CREATE UNIQUE INDEX "traveler_trips_traveler_id_external_event_id_key" ON "traveler_trips"("traveler_id", "external_event_id");

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

