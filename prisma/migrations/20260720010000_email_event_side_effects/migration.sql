-- ============================================================================
-- EMAIL EVENT SIDE-EFFECT STATE (2026-07-20) — finding EMAIL-P0-01
--
-- Recording a provider event and APPLYING its consequence are two different
-- things. Before this, only the record existed: if the suppression write for a
-- hard bounce or spam complaint failed, the webhook still returned HTTP 200 and
-- the unique provider_event_id deduplicated away every provider retry. The
-- address stayed sendable forever, with no trace.
--
-- These columns make the side effect DURABLE, so an unfinished suppression is
-- visible and retryable rather than silently lost.
--
-- Additive + idempotent. Existing rows default to 'processed', which is correct:
-- they were written under the old code path where the handler had already run
-- its suppression attempt inline, and we cannot retroactively know which failed.
-- The retry sweep therefore only governs events recorded from now on.
-- ============================================================================

ALTER TABLE "email_events"
  ADD COLUMN IF NOT EXISTS "processing_status" TEXT NOT NULL DEFAULT 'processed';

ALTER TABLE "email_events"
  ADD COLUMN IF NOT EXISTS "side_effect_attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "email_events"
  ADD COLUMN IF NOT EXISTS "side_effect_error" TEXT;

-- updated_at: added with a default so the ALTER succeeds on existing rows, then
-- the default is dropped so Prisma's @updatedAt owns the value going forward.
ALTER TABLE "email_events"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "email_events" ALTER COLUMN "updated_at" DROP DEFAULT;

CREATE INDEX IF NOT EXISTS "email_events_processing_status_idx"
  ON "email_events"("processing_status");

-- Guard the finite state set at the database level, so an application bug
-- cannot write a status the retry sweep does not understand.
DO $$ BEGIN
  ALTER TABLE "email_events" ADD CONSTRAINT "email_events_processing_status_check"
    CHECK ("processing_status" IN ('processed', 'side_effect_pending', 'side_effect_failed', 'dead_letter'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
