-- Service-area travel-fee fields on bookings (see src/lib/service-area.ts).
-- All additive + nullable/defaulted, so this is a safe forward-only migration.

-- CreateEnum
CREATE TYPE "ServiceAreaZone" AS ENUM ('primary', 'extended_nj', 'new_york', 'manual_review', 'unsupported');

-- AlterTable
ALTER TABLE "bookings"
  ADD COLUMN "service_area_zone" "ServiceAreaZone",
  ADD COLUMN "travel_fee" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "travel_fee_due_on_move_day" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manual_review_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "service_area_message" TEXT,
  ADD COLUMN "distance_from_west_orange_miles" DOUBLE PRECISION,
  ADD COLUMN "estimated_drive_time_minutes" INTEGER,
  ADD COLUMN "address_evaluation" JSONB;
