-- ══════════════════════════════════════════════════════════════════════════
--  TWO-PRODUCT MODEL (owner spec 2026-07-31)
--
--  Full-service moving (crew + truck, flat package + $3 per routed mile) and
--  labor-only moving help ($150/hour for two workers, customer supplies the
--  truck) become separate products with separate money.
--
--  HISTORICAL SAFETY — the whole point of this file:
--    • Every column added here is NULLABLE, or has a DEFAULT that means
--      "not applicable". Nothing back-fills a value onto an existing booking.
--    • NOTHING in this migration touches base_rate, total_estimate, travel_fee,
--      truck_addon_amount, final_amount or deposit_amount. Every historical
--      booking keeps the exact money it was quoted and approved.
--    • The retired studio packages are NOT deleted from anything. A booking
--      that selected "Large Studio — $549" still reads "Large Studio — $549"
--      forever, because that label and price live on the booking row and in
--      items_description, not in the price book.
--    • travel_fee is deliberately left alone. Bookings approved before today
--      keep the distance-band travel fee they agreed to; new bookings get a
--      transportation_charge instead. The two are distinguishable because a new
--      booking also carries routed_miles.
--
--  Reversible: every statement is an additive ADD COLUMN / ADD VALUE.
-- ══════════════════════════════════════════════════════════════════════════

-- ── Which product, and exactly what was sold ──────────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "service_type_key"        TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "package_key"             TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "package_label_snapshot"  TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "package_price_snapshot"  INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "package_is_legacy"       BOOLEAN NOT NULL DEFAULT false;

-- ── Full-service truck ────────────────────────────────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "included_truck_size"        TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "confirmed_truck_size"       TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "truck_size_upgrade_applied" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "truck_size_upgrade_amount"  INTEGER;

-- ── Full-service transportation: $3 per routed mile, fuel included ────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "routed_miles"          DOUBLE PRECISION;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "billable_miles"        INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "mileage_rate_cents"    INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "transportation_charge" INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "route_status"          TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "route_summary"         JSONB;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "route_override_reason" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "route_manual_review"   BOOLEAN NOT NULL DEFAULT false;

-- ── Labor-only: hourly, two workers, customer supplies transportation ─────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_service_type"      TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_estimated_hours"   DOUBLE PRECISION;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_hourly_rate_cents" INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_workers"           INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_actual_start"      TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_actual_end"        TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_pause_minutes"     INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_billable_hours"    DOUBLE PRECISION;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_subtotal"          INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "customer_truck_status"   TEXT;

-- Finding every labor-only job, and every job whose transportation still needs
-- a human, are both routine admin queries. Partial indexes keep them cheap
-- without adding weight to the (far more numerous) full-service rows.
CREATE INDEX IF NOT EXISTS "bookings_service_type_key_idx"
  ON "bookings" ("service_type_key") WHERE "service_type_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "bookings_route_manual_review_idx"
  ON "bookings" ("route_manual_review") WHERE "route_manual_review" = true;

-- ── Pricing audit actions ─────────────────────────────────────────────────
-- IF NOT EXISTS so a partially-applied migration can be re-run safely.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TRUCK_SIZE_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TRUCK_UPGRADE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ROUTE_MILEAGE_OVERRIDDEN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ROUTE_REVIEW_FLAGGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LABOR_TIME_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPROVAL_SUMMARY_REGENERATED';
