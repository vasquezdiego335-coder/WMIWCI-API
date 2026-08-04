-- ═══════════════════════════════════════════════════════════════════════════
--  QUOTE-REQUEST CAPTURE + NOTIFICATION STATE (owner spec 2026-08-03)
--
--  Additive only. Every column nullable or defaulted, and re-runnable.
--
--  Queue state and delivery state are deliberately SEPARATE columns: the API
--  records that a job was queued, and only the worker — after the provider
--  answers — may write 'delivered'. A single "sentAt" column written before the
--  enqueue is how an admin ends up reading "Sent" for an email Redis refused.
--
--  Per-send delivery detail (attempts, provider ids, idempotency key) stays in
--  EmailSend and is NOT duplicated here.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "contact_preference" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "best_time_to_call" TEXT;

ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_queued_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_status" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_delivered_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_failed_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_last_error" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_fingerprint" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "last_alerted_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_status" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_delivered_at" TIMESTAMP(3);

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEAD_QUOTE_CONFIRMATION_RESENT';

-- The admin lead list filters on confirmation state.
CREATE INDEX IF NOT EXISTS "crm_leads_quote_confirmation_status_idx"
    ON "crm_leads" ("quote_confirmation_status");
