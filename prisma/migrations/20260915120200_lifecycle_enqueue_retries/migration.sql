-- ═══════════════════════════════════════════════════════════════════════════
--  DURABLE LIFECYCLE ENQUEUE RETRIES  (production reliability release 2026-09-15)
--
--  THE DEFECT
--  ----------
--  Every lifecycle scheduler (abandoned checkout, pre-move reminders, balance
--  reminder, lead nurture, quote follow-ups, post-job follow-ups, payment-step
--  fan-out) raced queue.add against a 5s timeout, logged the failure as
--  non-fatal and then logged "scheduled" anyway. A Redis stall deleted the
--  customer's sequence and nothing ever retried it.
--
--  THE FIX
--  -------
--  A failed add records the EXACT job (queue, name, data, deterministic job id,
--  intended fire time) here. The hourly lifecycle-repair sweep re-adds that same
--  job id, and abandons the row once `not_after` has passed — it never replays
--  older history. One row per job id (unique), so repeated failures upsert.
--
--  No foreign keys on purpose: bookings and leads can be deleted, and every
--  stage handler rechecks its subject at run time.
--
--  TABLE NAME — CHECKED, NOT ASSUMED
--  ---------------------------------
--  Model LifecycleEnqueueRetry is @@map("lifecycle_enqueue_retries").
--
--  Additive only: a new table and its indexes. No existing table is touched.
--
--  RE-RUNNABLE, like its two siblings in this release (…120000 and …120100,
--  which use IF NOT EXISTS throughout). Any route that reaches this file with
--  the objects already present — a statement applied by hand during an incident,
--  a re-run after a partially applied deploy — would otherwise abort with
--  `relation "lifecycle_enqueue_retries" already exists`; `migrate deploy` then
--  records the migration FAILED and blocks every later deploy until someone runs
--  `migrate resolve --rolled-back`. These indexes are built non-concurrently
--  inside the same transaction as the table, so IF NOT EXISTS cannot mask an
--  INVALID index the way it could after a failed CREATE INDEX CONCURRENTLY.
--
--  Rollback:
--    DROP TABLE IF EXISTS "lifecycle_enqueue_retries";
--  (drops the table and its indexes; the application code must be rolled back
--  first, or failed enqueues will log LIFECYCLE_ENQUEUE_LOST.)
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE IF NOT EXISTS "lifecycle_enqueue_retries" (
    "id" TEXT NOT NULL,
    "queue_name" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "fire_at" TIMESTAMP(3) NOT NULL,
    "not_after" TIMESTAMP(3) NOT NULL,
    "path" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "lifecycle_enqueue_retries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "lifecycle_enqueue_retries_job_id_key" ON "lifecycle_enqueue_retries"("job_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "lifecycle_enqueue_retries_status_next_attempt_at_idx" ON "lifecycle_enqueue_retries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "lifecycle_enqueue_retries_subject_type_subject_id_idx" ON "lifecycle_enqueue_retries"("subject_type", "subject_id");
