-- Public booking reference (WMIC-####).
--
-- Backed by an ATOMIC Postgres SEQUENCE so two concurrent inserts can never
-- receive the same reference (never per-row counting, never random ids). The internal
-- cuid `id` is UNCHANGED and remains the key for every relationship/join/webhook.
-- The application also mirrors this value into `display_id` for backward
-- compatibility with existing customer/owner-facing surfaces.
--
-- START is configurable: change START WITH below (or run
-- `ALTER SEQUENCE booking_reference_seq RESTART WITH <n>`) if the database already
-- holds bookings you want numbered from a specific point. The backfill script
-- (scripts/backfill-booking-reference.ts) consumes this SAME sequence, so
-- backfilled rows and live inserts share one monotonic, collision-free series.
CREATE SEQUENCE IF NOT EXISTS booking_reference_seq AS BIGINT START WITH 1000 INCREMENT BY 1;

-- Additive + nullable: existing rows (incl. historical internal-test bookings)
-- stay NULL until the backfill assigns real references. Multiple NULLs are
-- allowed under a Postgres unique index (NULLs are distinct).
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "booking_reference" TEXT;

-- Defence in depth: any INSERT path that does NOT set booking_reference still
-- gets a unique atomic value. The API sets it explicitly (to also mirror
-- display_id), so this default only fires for non-API inserts.
ALTER TABLE "bookings"
  ALTER COLUMN "booking_reference" SET DEFAULT ('WMIC-' || nextval('booking_reference_seq')::text);

CREATE UNIQUE INDEX IF NOT EXISTS "bookings_booking_reference_key"
  ON "bookings" ("booking_reference");
