-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('shopper', 'traveler', 'both');

-- CreateEnum
CREATE TYPE "KycProvider" AS ENUM ('stripe_identity', 'veriff');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('none', 'pending', 'processing', 'verified', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "StripeAccountStatus" AS ENUM ('none', 'pending', 'charges_enabled', 'payouts_enabled', 'restricted');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'frozen', 'banned');

-- CreateEnum
CREATE TYPE "TripDirection" AS ENUM ('us_to_gh', 'gh_to_us');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('upcoming', 'in_progress', 'completed', 'canceled');

-- CreateEnum
CREATE TYPE "ItemCategory" AS ENUM ('electronics', 'clothing_shoes', 'cosmetics_sealed', 'books_media', 'food_sealed_nonperishable', 'foodstuffs_cbp_permitted', 'textiles_kente', 'crafts_nonrestricted');

-- CreateEnum
CREATE TYPE "ItemReviewStatus" AS ENUM ('auto_approved', 'pending_review', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('open', 'funded', 'completed', 'expired', 'canceled');

-- CreateEnum
CREATE TYPE "BidStatus" AS ENUM ('pending', 'accepted', 'funded', 'purchased', 'in_transit', 'arrived', 'delivered', 'refunded', 'disputed', 'expired', 'withdrawn');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('charge', 'application_fee', 'payout_release', 'refund', 'fee_refund', 'transfer_reversal', 'escrow_open', 'escrow_fund', 'escrow_release', 'escrow_refund');

-- CreateEnum
CREATE TYPE "LedgerStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "DisputeReason" AS ENUM ('item_not_as_described', 'item_damaged', 'no_show', 'payment_issue', 'other');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'under_review', 'resolved_refund', 'resolved_release', 'resolved_partial', 'closed');

-- CreateEnum
CREATE TYPE "RatingCategory" AS ENUM ('communication', 'punctuality', 'professionalism', 'overall');

-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('stripe', 'kyc');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('support', 'ops', 'admin');

-- CreateEnum
CREATE TYPE "EscrowState" AS ENUM ('none', 'opened', 'funded', 'released', 'refunded');

-- CreateEnum
CREATE TYPE "MatchProposalStatus" AS ENUM ('proposed', 'dismissed', 'converted');

-- CreateEnum
CREATE TYPE "NegotiationStatus" AS ENUM ('deal', 'no_deal');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(50),
    "user_role" "UserRole" NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "kyc_provider" "KycProvider",
    "kyc_session_id" VARCHAR(255),
    "kyc_status" "KycStatus" NOT NULL DEFAULT 'none',
    "passport_country" CHAR(2),
    "date_of_birth" DATE,
    "stripe_customer_id" VARCHAR(255),
    "stripe_connect_account_id" VARCHAR(255),
    "stripe_account_status" "StripeAccountStatus" NOT NULL DEFAULT 'none',
    "trust_score" INTEGER NOT NULL DEFAULT 100,
    "total_deliveries" INTEGER NOT NULL DEFAULT 0,
    "avg_rating" DECIMAL(2,1),
    "account_status" "AccountStatus" NOT NULL DEFAULT 'active',
    "wallet_address" VARCHAR(42),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traveler_trips" (
    "id" UUID NOT NULL,
    "traveler_id" UUID NOT NULL,
    "direction" "TripDirection" NOT NULL,
    "departure_city" VARCHAR(100) NOT NULL,
    "destination_city" VARCHAR(100) NOT NULL,
    "departure_date" DATE NOT NULL,
    "return_date" DATE,
    "luggage_capacity_kg" INTEGER NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'upcoming',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "traveler_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_requests" (
    "id" UUID NOT NULL,
    "shopper_id" UUID NOT NULL,
    "item_name" VARCHAR(255) NOT NULL,
    "item_cost_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "item_url" TEXT,
    "item_image_url" TEXT,
    "category" "ItemCategory" NOT NULL,
    "direction" "TripDirection" NOT NULL,
    "destination_city" VARCHAR(100) NOT NULL,
    "recipient_name" VARCHAR(255),
    "recipient_phone" VARCHAR(50),
    "review_status" "ItemReviewStatus" NOT NULL DEFAULT 'pending_review',
    "status" "ItemStatus" NOT NULL DEFAULT 'open',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "item_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bids" (
    "id" UUID NOT NULL,
    "item_request_id" UUID NOT NULL,
    "traveler_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "item_cost_cents_snapshot" INTEGER NOT NULL,
    "traveler_fee_cents" INTEGER NOT NULL,
    "commission_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "promised_delivery_date" DATE NOT NULL,
    "stripe_payment_intent_id" VARCHAR(255),
    "status" "BidStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ,
    "funded_at" TIMESTAMPTZ,
    "purchased_at" TIMESTAMPTZ,
    "in_transit_at" TIMESTAMPTZ,
    "arrived_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "refunded_at" TIMESTAMPTZ,
    "escrow_id" VARCHAR(66),
    "escrow_state" "EscrowState" NOT NULL DEFAULT 'none',
    "escrow_fund_tx_hash" VARCHAR(66),
    "escrow_settle_tx_hash" VARCHAR(66),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_codes" (
    "id" UUID NOT NULL,
    "bid_id" UUID NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "confirmed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_ledger" (
    "id" UUID NOT NULL,
    "bid_id" UUID NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "stripe_object_id" VARCHAR(255),
    "onchain_tx_hash" VARCHAR(66),
    "status" "LedgerStatus" NOT NULL DEFAULT 'pending',
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payout_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_proposals" (
    "id" UUID NOT NULL,
    "item_request_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "traveler_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "status" "MatchProposalStatus" NOT NULL DEFAULT 'proposed',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "match_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negotiation_sessions" (
    "id" UUID NOT NULL,
    "item_request_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "shopper_id" UUID NOT NULL,
    "traveler_id" UUID NOT NULL,
    "status" "NegotiationStatus" NOT NULL,
    "agreed_fee_cents" INTEGER,
    "transcript" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "negotiation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "bid_id" UUID NOT NULL,
    "opened_by" UUID NOT NULL,
    "reason" "DisputeReason" NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolution_notes" TEXT,
    "resolved_by" UUID,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "item_request_id" UUID NOT NULL,
    "bid_id" UUID,
    "shopper_id" UUID NOT NULL,
    "traveler_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_ratings" (
    "id" UUID NOT NULL,
    "bid_id" UUID NOT NULL,
    "rater_id" UUID NOT NULL,
    "rated_id" UUID NOT NULL,
    "category" "RatingCategory" NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role" "AdminRole" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "dispute_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_wallet_address_key" ON "users"("wallet_address");

-- CreateIndex
CREATE INDEX "traveler_trips_traveler_id_idx" ON "traveler_trips"("traveler_id");

-- CreateIndex
CREATE INDEX "traveler_trips_direction_departure_date_idx" ON "traveler_trips"("direction", "departure_date");

-- CreateIndex
CREATE INDEX "item_requests_status_direction_idx" ON "item_requests"("status", "direction");

-- CreateIndex
CREATE INDEX "item_requests_shopper_id_idx" ON "item_requests"("shopper_id");

-- CreateIndex
CREATE UNIQUE INDEX "bids_stripe_payment_intent_id_key" ON "bids"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "bids_escrow_id_key" ON "bids"("escrow_id");

-- CreateIndex
CREATE INDEX "bids_item_request_id_idx" ON "bids"("item_request_id");

-- CreateIndex
CREATE INDEX "bids_traveler_id_idx" ON "bids"("traveler_id");

-- CreateIndex
CREATE INDEX "bids_trip_id_idx" ON "bids"("trip_id");

-- CreateIndex
CREATE INDEX "bids_status_idx" ON "bids"("status");

-- CreateIndex
CREATE INDEX "handover_codes_bid_id_idx" ON "handover_codes"("bid_id");

-- CreateIndex
CREATE INDEX "payout_ledger_bid_id_idx" ON "payout_ledger"("bid_id");

-- CreateIndex
CREATE INDEX "match_proposals_traveler_id_status_idx" ON "match_proposals"("traveler_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "match_proposals_item_request_id_trip_id_key" ON "match_proposals"("item_request_id", "trip_id");

-- CreateIndex
CREATE INDEX "negotiation_sessions_item_request_id_trip_id_idx" ON "negotiation_sessions"("item_request_id", "trip_id");

-- CreateIndex
CREATE INDEX "disputes_bid_id_idx" ON "disputes"("bid_id");

-- CreateIndex
CREATE INDEX "disputes_status_idx" ON "disputes"("status");

-- CreateIndex
CREATE INDEX "conversations_shopper_id_idx" ON "conversations"("shopper_id");

-- CreateIndex
CREATE INDEX "conversations_traveler_id_idx" ON "conversations"("traveler_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_idx" ON "messages"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_ratings_bid_id_rater_id_category_key" ON "user_ratings"("bid_id", "rater_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_external_id_key" ON "webhook_events"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_audit_log_target_type_target_id_idx" ON "admin_audit_log"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "traveler_trips" ADD CONSTRAINT "traveler_trips_traveler_id_fkey" FOREIGN KEY ("traveler_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_shopper_id_fkey" FOREIGN KEY ("shopper_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_item_request_id_fkey" FOREIGN KEY ("item_request_id") REFERENCES "item_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_traveler_id_fkey" FOREIGN KEY ("traveler_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "traveler_trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_codes" ADD CONSTRAINT "handover_codes_bid_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bids"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_ledger" ADD CONSTRAINT "payout_ledger_bid_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bids"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_bid_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bids"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_bid_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_item_request_id_fkey" FOREIGN KEY ("item_request_id") REFERENCES "item_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_ratings" ADD CONSTRAINT "user_ratings_bid_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bids"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
