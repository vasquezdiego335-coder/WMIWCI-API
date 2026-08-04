-- ═══════════════════════════════════════════════════════════════════════════
--  QUOTE-REQUEST LEAD CAPTURE (owner spec 2026-08-03)
--
--  Two independent changes, both purely additive:
--    1. LeadSource gains the channels that were all collapsing into OTHER.
--    2. crm_leads gains the quote-request columns (contact preference, the
--       confirmation-email stamp, and the owner-alert dedupe fingerprint).
--
--  NOTHING IS BACKFILLED. Existing rows keep source = OTHER: we do not know
--  retroactively whether those visitors were DIRECT or UNKNOWN, and inventing
--  that distinction would be worse than leaving the honest historical value.
--  New rows are classified by src/lib/lead-attribution.ts.
--
--  POSTGRES NOTE: `ALTER TYPE ... ADD VALUE` is permitted inside a transaction
--  from PG 12 onward, but the new value may NOT be USED in the same
--  transaction. This migration only ADDS values and columns — no statement
--  below writes one of the new labels — so it is safe as a single migration.
--  IF NOT EXISTS makes the whole file re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. New lead channels ───────────────────────────────────────────────────
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'DIRECT';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'ORGANIC_SEARCH';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'GOOGLE_ADS';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'TIKTOK';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'MARKETPLACE';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'QR_CODE';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'UNKNOWN';

-- ── 2. Audit action for an owner-triggered confirmation resend ─────────────
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEAD_QUOTE_CONFIRMATION_RESENT';

-- ── 3. Quote-request columns on crm_leads ──────────────────────────────────
--  All nullable (or defaulted) so every pre-existing row stays valid and the
--  deploy needs no write lock beyond the catalogue update.
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "contact_preference" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "best_time_to_call" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "pickup_zip" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "destination_zip" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "source_detail" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_request_confirmation_sent_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_request_confirmation_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_fingerprint" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "last_alerted_at" TIMESTAMP(3);
