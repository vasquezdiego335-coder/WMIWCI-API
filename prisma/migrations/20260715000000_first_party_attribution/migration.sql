-- First-party ad attribution columns on leads + bookings.
-- Captured client-side (public/js/attribution.js), stored first-party only,
-- never forwarded to GA4. Ready for Google Ads offline-conversion import (gclid).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) to match this project's migration style,
-- since migrations are applied deliberately with `npm run db:migrate:prod`.

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "gclid" TEXT,
  ADD COLUMN IF NOT EXISTS "gbraid" TEXT,
  ADD COLUMN IF NOT EXISTS "wbraid" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_source" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_medium" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_campaign" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_term" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_content" TEXT,
  ADD COLUMN IF NOT EXISTS "landing_page" TEXT,
  ADD COLUMN IF NOT EXISTS "initial_referrer" TEXT,
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
  ADD COLUMN IF NOT EXISTS "initial_referrer" TEXT,
  ADD COLUMN IF NOT EXISTS "first_touch_at" TIMESTAMP(3);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (run manually if you need to revert; Prisma has no down-migrations):
--
-- ALTER TABLE "leads"
--   DROP COLUMN IF EXISTS "gclid", DROP COLUMN IF EXISTS "gbraid",
--   DROP COLUMN IF EXISTS "wbraid", DROP COLUMN IF EXISTS "utm_source",
--   DROP COLUMN IF EXISTS "utm_medium", DROP COLUMN IF EXISTS "utm_campaign",
--   DROP COLUMN IF EXISTS "utm_term", DROP COLUMN IF EXISTS "utm_content",
--   DROP COLUMN IF EXISTS "landing_page", DROP COLUMN IF EXISTS "initial_referrer",
--   DROP COLUMN IF EXISTS "first_touch_at";
-- ALTER TABLE "bookings"
--   DROP COLUMN IF EXISTS "gclid", DROP COLUMN IF EXISTS "gbraid",
--   DROP COLUMN IF EXISTS "wbraid", DROP COLUMN IF EXISTS "utm_source",
--   DROP COLUMN IF EXISTS "utm_medium", DROP COLUMN IF EXISTS "utm_campaign",
--   DROP COLUMN IF EXISTS "utm_term", DROP COLUMN IF EXISTS "utm_content",
--   DROP COLUMN IF EXISTS "landing_page", DROP COLUMN IF EXISTS "initial_referrer",
--   DROP COLUMN IF EXISTS "first_touch_at";
-- ─────────────────────────────────────────────────────────────────────────────
