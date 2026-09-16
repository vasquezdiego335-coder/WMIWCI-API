-- ═══════════════════════════════════════════════════════════════════════════
--  CAMPAIGN RECIPIENTS: DURABLE RETRY TIME + TRANSIENT-FAILURE BUDGET
--
--  THE DEFECT
--  ----------
--  A failed suppression-list READ (suppression_read_failed) was mapped to the
--  terminal recipient state SUPPRESSED. Nothing was sent — the guard fails
--  closed, correctly — but the recipient was closed for good, the run could
--  finish COMPLETED, and the row looked exactly like a real suppression. A
--  database blip silently removed people from a campaign.
--
--  The fix defers such recipients with bounded exponential backoff and retries
--  them. That needs two facts the table did not have:
--
--    next_attempt_at     when a DEFERRED row is due. The delayed queue job is
--                        only the fast path; the campaign sweep re-drives rows
--                        that are overdue (a lost job no longer strands the
--                        recipient and keeps the run open forever).
--    transient_attempts  consecutive transient read failures. At the cap the
--                        row becomes FAILED '<reason>:retries_exhausted' —
--                        visible and re-openable — never SUPPRESSED.
--
--  ADDITIVE ONLY. On PostgreSQL 11+ adding a nullable column, or one with a
--  constant default, is a metadata-only change. No backfill: existing rows get
--  NULL / 0, and the sweep deliberately ignores DEFERRED rows whose
--  next_attempt_at is NULL, so historical production rows are never touched.
--  Existing SUPPRESSED rows with reason 'suppression_read_failed' are NOT
--  rewritten; any re-open is a separate, owner-approved action.
--
--  DEPLOY ORDER. The new Prisma client selects these columns, so apply this
--  migration BEFORE either service runs the new code.
--
--  Rollback:
--    DROP INDEX IF EXISTS "email_campaign_recipients_status_next_attempt_at_idx";
--    ALTER TABLE "email_campaign_recipients" DROP COLUMN IF EXISTS "transient_attempts";
--    ALTER TABLE "email_campaign_recipients" DROP COLUMN IF EXISTS "next_attempt_at";
--  (Only after the code that writes them has been rolled back.)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP(3);
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "transient_attempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "email_campaign_recipients_status_next_attempt_at_idx"
    ON "email_campaign_recipients" ("status", "next_attempt_at");
