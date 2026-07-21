-- ============================================================================
-- FOLLOW-UP LEDGER: PER-CHANNEL STATE (2026-07-20) — finding EMAIL-P1-10
--
-- The ledger row was created with status='sent' BEFORE either channel had
-- delivered anything. An SMS that was merely ENQUEUED counted as sent; if both
-- channels then failed, the unique (booking_id, type) row remained, so the
-- follow-up could never be retried — and every report built on the ledger
-- claimed a delivery that never happened.
--
-- Queueing is not delivery. These columns record what actually happened on each
-- channel, so a retry can target only the FAILED side and reporting can
-- distinguish planned / queued / delivered / failed.
--
-- Additive + idempotent. Existing rows are migrated conservatively: a row that
-- said 'sent' is recorded as delivered (that is the best information we have),
-- but per-channel state is left NULL rather than invented.
-- ============================================================================

ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "email_status"      TEXT;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "sms_status"        TEXT;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "email_attempts"    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "sms_attempts"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "email_provider_id" TEXT;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "sms_provider_id"   TEXT;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "email_last_error"  TEXT;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "sms_last_error"    TEXT;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "next_attempt_at"   TIMESTAMP(3);
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "terminal_reason"   TEXT;
ALTER TABLE "followup_ledger" ADD COLUMN IF NOT EXISTS "delivered_at"      TIMESTAMP(3);

ALTER TABLE "followup_ledger"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "followup_ledger"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "followup_ledger" ALTER COLUMN "updated_at" DROP DEFAULT;

-- Vocabulary migration. 'sent' was the DEFAULT and was written before delivery,
-- so it cannot be trusted as proof — but it is the only signal these rows carry,
-- and downgrading them would wrongly re-open old follow-ups to a re-send.
-- delivered_at is backfilled from sent_at so reporting has a real timestamp.
UPDATE "followup_ledger" SET "status" = 'delivered', "delivered_at" = "sent_at"
  WHERE "status" = 'sent';
UPDATE "followup_ledger" SET "status" = 'failed_terminal'
  WHERE "status" = 'failed';
UPDATE "followup_ledger" SET "status" = 'skipped', "terminal_reason" = COALESCE("terminal_reason", "error")
  WHERE "status" = 'skipped';

-- The default for NEW rows is 'planned' — nothing is "sent" until it ships.
ALTER TABLE "followup_ledger" ALTER COLUMN "status" SET DEFAULT 'planned';

CREATE INDEX IF NOT EXISTS "followup_ledger_status_next_attempt_at_idx"
  ON "followup_ledger"("status", "next_attempt_at");

DO $$ BEGIN
  ALTER TABLE "followup_ledger" ADD CONSTRAINT "followup_ledger_status_check"
    CHECK ("status" IN (
      'planned', 'claimed', 'deferred', 'partially_delivered', 'delivered',
      'failed_retryable', 'failed_terminal', 'cancelled', 'skipped'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
