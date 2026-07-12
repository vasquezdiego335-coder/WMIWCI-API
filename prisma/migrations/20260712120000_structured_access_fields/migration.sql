-- Structured access details (owner spec 2026-07-12).
-- Backward-compatible: every column is NULLABLE, so existing bookings read as
-- NULL and nothing is rewritten. origin_floor / dest_floor already exist and are
-- reused for the floor number (not re-added here). origin_access_code /
-- dest_access_code are SENSITIVE (gate/lockbox/buzzer codes) — surfaced only in
-- the owner-gated Discord "View Full Booking" and authenticated admin views.

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "crew_instructions" TEXT,
ADD COLUMN     "dest_access_code" TEXT,
ADD COLUMN     "dest_access_notes" TEXT,
ADD COLUMN     "dest_has_elevator" BOOLEAN,
ADD COLUMN     "dest_stair_count" INTEGER,
ADD COLUMN     "dest_unit" TEXT,
ADD COLUMN     "equipment_needs" TEXT,
ADD COLUMN     "origin_access_code" TEXT,
ADD COLUMN     "origin_access_notes" TEXT,
ADD COLUMN     "origin_has_elevator" BOOLEAN,
ADD COLUMN     "origin_stair_count" INTEGER,
ADD COLUMN     "origin_unit" TEXT,
ADD COLUMN     "truck_pickup_location" TEXT,
ADD COLUMN     "truck_provider" TEXT,
ADD COLUMN     "truck_reservation_status" TEXT,
ADD COLUMN     "truck_return_responsibility" TEXT,
ADD COLUMN     "truck_size" TEXT;
