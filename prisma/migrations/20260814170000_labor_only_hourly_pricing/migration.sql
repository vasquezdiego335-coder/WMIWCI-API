-- ══════════════════════════════════════════════════════════════════════════
--  LABOR-ONLY HOURLY PRICING (repair audit 2026-08-14, P0-02)
--
--  The public booking form has been promising "$150 per hour for two
--  professional movers" while the server priced a flat bedroom package. There
--  was nowhere to store an hourly quote, so there was no way for the server to
--  honour what the customer was reading.
--
--  These columns are the authoritative labor quote, in INTEGER CENTS, computed
--  server-side by src/lib/product-catalog.ts. The customer's requested duration
--  is stored SEPARATELY from the billable duration so the two-hour minimum is
--  visible as a minimum rather than silently rewriting what they asked for.
--
--  HISTORICAL SAFETY:
--    • Every column is NULLABLE. Nothing is back-filled.
--    • No existing booking changes price: a full-service row leaves all of
--      these NULL and keeps reading base_rate / total_estimate exactly as
--      before.
--    • Additive only; safe to re-run.
--
--  DEPLOY ORDER: schema BEFORE code (Prisma selects all scalar columns).
-- ══════════════════════════════════════════════════════════════════════════

-- Which labor product: loading_only | unloading_only | load_and_unload
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_service" TEXT;

-- What the customer asked for, exactly as submitted. Never overwritten by the
-- minimum — an owner must be able to see "asked for 1h, billed the 2h minimum".
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_requested_minutes" INTEGER;

-- What we actually bill: max(requested, 120).
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_billable_minutes" INTEGER;

-- True when the two-hour minimum lifted the price above the request.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_minimum_applied" BOOLEAN;

-- The rate and crew size SNAPSHOTTED at booking time, so a future price change
-- can never silently re-price a quote the customer already accepted.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_rate_cents" INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_workers"    INTEGER;

-- INTEGER CENTS. billable_minutes × rate ÷ 60. THE labor line item.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "labor_subtotal_cents" INTEGER;

-- Finding labor-only jobs is a routine admin query; a partial index keeps it
-- cheap without adding weight to full-service rows.
CREATE INDEX IF NOT EXISTS "bookings_labor_service_idx"
  ON "bookings" ("labor_service") WHERE "labor_service" IS NOT NULL;
