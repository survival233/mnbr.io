-- AlterTable
ALTER TABLE "item_requests" ADD COLUMN     "availability_label" VARCHAR(100),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "reserved_bid_id" UUID,
ADD COLUMN     "reserved_traveler_id" UUID,
ADD COLUMN     "retailer_listing_id" VARCHAR(100),
ADD COLUMN     "retailer_name" VARCHAR(100),
ADD COLUMN     "shopping_city" VARCHAR(100);

-- CreateIndex
CREATE UNIQUE INDEX "item_requests_reserved_bid_id_key" ON "item_requests"("reserved_bid_id");

-- CreateIndex
CREATE INDEX "item_requests_destination_city_status_idx" ON "item_requests"("destination_city", "status");
