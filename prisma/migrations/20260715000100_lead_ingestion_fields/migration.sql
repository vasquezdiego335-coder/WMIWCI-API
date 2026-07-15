-- ============================================================================
-- LEAD INGESTION + ATTRIBUTION FIELDS (createOrUpdateLead, 2026-07-15)
-- Fully additive + idempotent (ADD COLUMN / CREATE INDEX ... IF NOT EXISTS).
-- Safe to apply on the live DB and safe to re-run — matches the repo's
-- `npx prisma migrate deploy` workflow. No data is modified or removed.
-- ============================================================================
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "message" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "origin_city" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "dest_city" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_source" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_medium" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_campaign" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_content" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_term" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "landing_page" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "referrer" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "promo_code" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "leads_email_idx" ON "leads"("email");
CREATE INDEX IF NOT EXISTS "leads_phone_idx" ON "leads"("phone");
CREATE INDEX IF NOT EXISTS "leads_last_activity_at_idx" ON "leads"("last_activity_at");
