-- ============================================================================
-- EMAIL SEND ATTEMPT STATE MACHINE (2026-07-20)
-- Findings EMAIL-P1-03 (provider failures were never retried) and
--          EMAIL-P1-04 (temporary blocks permanently consumed the delivery key)
--
-- Both had one root cause: the unique idempotency key WAS the outcome record.
-- The first thing that happened to a logical send — a provider 500, a quiet-
-- hours deferral, a suppression-table timeout — permanently occupied the key,
-- and every later attempt short-circuited as 'duplicate'. The email was never
-- sent and nothing surfaced that fact.
--
-- Delivery IDENTITY (idempotency_key) is now separate from ATTEMPT OUTCOME
-- (status). A row in a non-terminal state is RESUMED in place, so the logical
-- send stays single while attempts accumulate against it.
--
-- Additive + idempotent. Existing rows are migrated to the new vocabulary.
-- ============================================================================

ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "outcome_class"    TEXT;
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "attempts"         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "next_attempt_at"  TIMESTAMP(3);

-- Vocabulary migration for rows written by the previous code.
--   'sent'    → delivered (terminal, correct)
--   'claimed' → ambiguous: an attempt was in flight and we cannot know whether
--               the provider accepted it. Deliberately NOT marked retryable —
--               auto-resending these could double-send a real customer.
--   'failed'  → provider_rejected when no provider id was recorded (safe to
--               retry); ambiguous when one WAS recorded (it may have delivered).
--   'blocked' → blocked_terminal. Conservative: the old code did not record
--               whether a block was temporary, so we do not guess it was.
--               Operators can re-drive specific rows deliberately.
UPDATE "email_sends" SET "status" = 'delivered',         "outcome_class" = 'terminal'
  WHERE "status" = 'sent';
UPDATE "email_sends" SET "status" = 'ambiguous',         "outcome_class" = 'ambiguous'
  WHERE "status" = 'claimed';
UPDATE "email_sends" SET "status" = 'provider_rejected', "outcome_class" = 'retryable'
  WHERE "status" = 'failed' AND "provider_id" IS NULL;
UPDATE "email_sends" SET "status" = 'ambiguous',         "outcome_class" = 'ambiguous'
  WHERE "status" = 'failed' AND "provider_id" IS NOT NULL;
UPDATE "email_sends" SET "status" = 'blocked_terminal',  "outcome_class" = 'terminal'
  WHERE "status" = 'blocked';

-- Attempt count for pre-existing rows: at least one attempt was made unless the
-- row was only ever a block.
UPDATE "email_sends" SET "attempts" = 1
  WHERE "attempts" = 0 AND "status" IN ('delivered', 'ambiguous', 'provider_rejected');

CREATE INDEX IF NOT EXISTS "email_sends_status_next_attempt_at_idx"
  ON "email_sends"("status", "next_attempt_at");

-- Frequency-cap query support (finding EMAIL-P2-18). countSentSince() filters
-- email + email_class + status + sent_at; without this it scans every send to
-- the address on every promotional attempt.
CREATE INDEX IF NOT EXISTS "email_sends_email_class_status_sent_at_idx"
  ON "email_sends"("email", "email_class", "status", "sent_at");

-- Guard the finite state set in the database, so an application bug cannot
-- write a status the resume logic does not understand (finding EMAIL-P2-18).
DO $$ BEGIN
  ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_status_check"
    CHECK ("status" IN (
      'sending', 'delivered', 'provider_rejected', 'retry_pending',
      'ambiguous', 'deferred', 'blocked_retryable', 'blocked_terminal',
      'failed_terminal'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_email_class_check"
    CHECK ("email_class" IN ('transactional', 'promotional'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Suppression scope is likewise a finite set.
DO $$ BEGIN
  ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_scope_check"
    CHECK ("scope" IN ('promotional', 'all'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
