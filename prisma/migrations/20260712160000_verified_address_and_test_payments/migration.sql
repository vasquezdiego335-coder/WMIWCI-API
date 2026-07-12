-- Phase 2 (owner spec 2026-07-12): verified structured addresses + internal-test
-- payment flag. Additive + idempotent: all columns nullable except the payment
-- flag (DEFAULT false is metadata-only in PG11+, no table rewrite). Safe to re-run.

-- ── Bookings: server-verified structured address (origin + dest) ──
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "origin_street_number" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_route" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_city" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_county" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_state" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_zip" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_country" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_formatted_address" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_lat" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "origin_lng" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "origin_place_id" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_verification_status" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_validation_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_street_number" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_route" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_city" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_county" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_state" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_zip" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_country" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_formatted_address" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_lat" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "dest_lng" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "dest_place_id" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_verification_status" TEXT,
  ADD COLUMN IF NOT EXISTS "dest_validation_reason" TEXT;

-- ── Payments: internal-test flag (excluded from all revenue reporting) ──
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "is_internal_test" BOOLEAN NOT NULL DEFAULT false;

-- ── Bookings: internal-test flag (excluded from operational counts) ──
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "is_internal_test" BOOLEAN NOT NULL DEFAULT false;
