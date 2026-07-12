-- Structured access details (owner spec 2026-07-12).
-- Backward-compatible: every column is NULLABLE, so existing bookings read as
-- NULL and nothing is rewritten. origin_floor / dest_floor already exist and are
-- reused for the floor number (not re-added here). origin_access_code /
-- dest_access_code are SENSITIVE (gate/lockbox/buzzer codes) — surfaced only in
-- the owner-gated Discord "View Full Booking" and authenticated admin views.

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS     "crew_instructions" TEXT,
ADD COLUMN IF NOT EXISTS     "dest_access_code" TEXT,
ADD COLUMN IF NOT EXISTS     "dest_access_notes" TEXT,
ADD COLUMN IF NOT EXISTS     "dest_has_elevator" BOOLEAN,
ADD COLUMN IF NOT EXISTS     "dest_stair_count" INTEGER,
ADD COLUMN IF NOT EXISTS     "dest_unit" TEXT,
ADD COLUMN IF NOT EXISTS     "equipment_needs" TEXT,
ADD COLUMN IF NOT EXISTS     "origin_access_code" TEXT,
ADD COLUMN IF NOT EXISTS     "origin_access_notes" TEXT,
ADD COLUMN IF NOT EXISTS     "origin_has_elevator" BOOLEAN,
ADD COLUMN IF NOT EXISTS     "origin_stair_count" INTEGER,
ADD COLUMN IF NOT EXISTS     "origin_unit" TEXT,
ADD COLUMN IF NOT EXISTS     "truck_pickup_location" TEXT,
ADD COLUMN IF NOT EXISTS     "truck_provider" TEXT,
ADD COLUMN IF NOT EXISTS     "truck_reservation_status" TEXT,
ADD COLUMN IF NOT EXISTS     "truck_return_responsibility" TEXT,
ADD COLUMN IF NOT EXISTS     "truck_size" TEXT;
