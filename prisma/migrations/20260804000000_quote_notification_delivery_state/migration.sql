-- ═══════════════════════════════════════════════════════════════════════════
--  QUOTE NOTIFICATION: QUEUE STATE vs DELIVERY STATE (repair pass 2026-08-04)
--
--  The previous migration gave the lead ONE column,
--  `quote_request_confirmation_sent_at`, which the API wrote BEFORE the BullMQ
--  insert. That made the admin read "Sent" for an email Redis had refused, and
--  gave the system no way to record a terminal provider failure at all.
--
--  This adds explicit state for BOTH notifications. The old column is KEPT and
--  reused as the "queued at" timestamp — the Prisma field was renamed to
--  `quoteConfirmationQueuedAt` via @map, so no data moves and nothing breaks.
--
--  True per-send delivery state (attempts, provider ids, idempotency key)
--  continues to live in EmailSend and is NOT duplicated here. These columns
--  exist so the LEAD row can answer "did this customer get their
--  confirmation?" without a join, which is what the admin list needs.
--
--  Purely additive. Every column nullable. Re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_status" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_delivered_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_failed_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_last_error" TEXT;

ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_status" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_delivered_at" TIMESTAMP(3);

-- Backfill: a row that already carries a queued-at timestamp from the previous
-- deploy is recorded as 'queued'. It is deliberately NOT recorded as delivered
-- — we do not know that, and guessing is the exact defect this migration
-- removes.
UPDATE "crm_leads"
   SET "quote_confirmation_status" = 'queued'
 WHERE "quote_request_confirmation_sent_at" IS NOT NULL
   AND "quote_confirmation_status" IS NULL;

UPDATE "crm_leads"
   SET "alert_status" = 'queued'
 WHERE "last_alerted_at" IS NOT NULL
   AND "alert_status" IS NULL;

-- The admin lead list filters on confirmation state; without this it sequential
-- scans crm_leads on every page load once the table grows.
CREATE INDEX IF NOT EXISTS "crm_leads_quote_confirmation_status_idx"
    ON "crm_leads" ("quote_confirmation_status");
