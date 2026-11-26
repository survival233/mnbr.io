-- Lightweight persistent webhook idempotency store.
CREATE TABLE "processed_webhooks" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "processed_webhooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "processed_webhooks_provider_event" ON "processed_webhooks"("provider", "event_id");

CREATE INDEX "processed_webhooks_received_at_idx" ON "processed_webhooks"("received_at");
