-- Google ad click identifiers + first-touch time.
-- Lead already has utm_*/landing_page/referrer (20260715000100_lead_ingestion_fields);
-- this only adds the genuinely-new columns. Booking had none, so it gets the full set.
-- Idempotent (ADD COLUMN IF NOT EXISTS) — applied deliberately via db:migrate:prod.

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "gclid" TEXT,
  ADD COLUMN IF NOT EXISTS "gbraid" TEXT,
  ADD COLUMN IF NOT EXISTS "wbraid" TEXT,
  ADD COLUMN IF NOT EXISTS "first_touch_at" TIMESTAMP(3);

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "gclid" TEXT,
  ADD COLUMN IF NOT EXISTS "gbraid" TEXT,
  ADD COLUMN IF NOT EXISTS "wbraid" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_source" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_medium" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_campaign" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_term" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_content" TEXT,
  ADD COLUMN IF NOT EXISTS "landing_page" TEXT,
  ADD COLUMN IF NOT EXISTS "first_touch_at" TIMESTAMP(3);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual; Prisma has no down-migrations):
--   ALTER TABLE "leads" DROP COLUMN IF EXISTS "gclid", DROP COLUMN IF EXISTS "gbraid",
--     DROP COLUMN IF EXISTS "wbraid", DROP COLUMN IF EXISTS "first_touch_at";
--   ALTER TABLE "bookings" DROP COLUMN IF EXISTS "gclid", DROP COLUMN IF EXISTS "gbraid",
--     DROP COLUMN IF EXISTS "wbraid", DROP COLUMN IF EXISTS "utm_source",
--     DROP COLUMN IF EXISTS "utm_medium", DROP COLUMN IF EXISTS "utm_campaign",
--     DROP COLUMN IF EXISTS "utm_term", DROP COLUMN IF EXISTS "utm_content",
--     DROP COLUMN IF EXISTS "landing_page", DROP COLUMN IF EXISTS "first_touch_at";
-- ─────────────────────────────────────────────────────────────────────────────
