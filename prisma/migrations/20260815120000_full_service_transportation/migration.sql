-- ══════════════════════════════════════════════════════════════════════════
--  FULL-SERVICE TRANSPORTATION — $3 PER ROUTED MILE (owner rule 2026-08-15)
--
--  Replaces the retired extended-NJ travel-band fee for NEW bookings. The old
--  `travel_fee` column is NOT touched, dropped or back-filled: a booking
--  approved before 2026-07-31 keeps the fee it agreed to, read from its stored
--  row and never recalculated. A booking may carry one or the other — never
--  both, which src/lib/pricing-config.assertNoDoubleTravelCharge enforces.
--
--  Measured SERVER-SIDE from the first pickup through every requested stop to
--  the final drop-off, whole route rounded UP. A browser-supplied distance or
--  dollar amount is never trusted.
--
--  LABOR-ONLY LEAVES EVERY COLUMN NULL. The customer supplies the truck, so
--  there is no transportation to bill and no address reaches a routing
--  provider at all.
--
--  HISTORICAL SAFETY:
--    • Every column is NULLABLE or has a DEFAULT meaning "not applicable".
--    • Nothing is back-filled; no existing booking changes price.
--    • Additive only — no DROP, no ALTER TYPE, no data rewrite.
--    • ADD COLUMN IF NOT EXISTS, so a partially applied run is safe to repeat.
--
--  DEPLOY ORDER: schema BEFORE code. Prisma selects all scalar columns by
--  default, so code deployed first would throw on every booking read.
-- ══════════════════════════════════════════════════════════════════════════

-- Raw measured distance, before rounding. Kept so an owner can always see what
-- the router actually returned versus what was billed.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "routed_miles" DOUBLE PRECISION;

-- The WHOLE route rounded UP to the next mile. This is what is billed.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "billable_miles" INTEGER;

-- Rate SNAPSHOT in integer cents (30000 = $3.00/mile), so a future rate change
-- can never silently re-price a quote the customer already accepted.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "mileage_rate_cents" INTEGER;

-- INTEGER CENTS. billable_miles x mileage_rate_cents. THE transportation line.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "transportation_charge" INTEGER;

-- measured | skipped | failed. Why we do, or do not, have a distance. NULL on
-- labor-only, where routing is never attempted.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "route_status" TEXT;

-- The route could not be measured, so an owner prices it before approval. A
-- null distance NEVER becomes a zero charge.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "route_manual_review" BOOLEAN NOT NULL DEFAULT false;

-- Distances, duration and status WITHOUT the address strings. Addresses go to
-- the routing provider and nowhere else; this is what is safe to persist.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "route_summary" JSONB;

-- Finding routes an owner still has to price is a routine admin query; a
-- partial index keeps it cheap without weighing down rows that are fine.
CREATE INDEX IF NOT EXISTS "bookings_route_manual_review_idx"
  ON "bookings" ("route_manual_review") WHERE "route_manual_review" = true;
