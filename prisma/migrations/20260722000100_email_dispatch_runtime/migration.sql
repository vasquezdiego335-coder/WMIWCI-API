-- ============================================================================
-- EMAIL DISPATCH RUNTIME (owner spec 2026-07-22)
--
-- Additive + idempotent. Adds the EXECUTION layer for the email marketing
-- admin shipped in 20260721230000_email_marketing_admin:
--   • 6 AuditAction values (dispatch / run pause / resume / cancel / retry /
--     lead quoted)
--   • email_campaign_runs        — one immutable dispatch of a campaign
--   • email_campaign_recipients  — one row per recipient per run (dedupe by
--                                  UNIQUE(run_id, email))
--   • email_automation_enrollments — one subject enrolled in one VERSION of
--                                  an automation (dedupe by UNIQUE dedupe_key)
--
-- NOTHING EXISTING IS ALTERED. No column is dropped or narrowed, no applied
-- migration is rewritten. Every new table is standalone; delivery truth stays
-- on email_sends — these tables reference it (email_send_id) rather than
-- duplicating provider outcomes.
--
-- DELETE POLICY: runs/recipients CASCADE from marketing_campaigns and
-- enrollments CASCADE from email_automations — they are orchestration state.
-- The email_sends ledger row (the proof a person was mailed) is NOT touched
-- by any of these deletes; it already survives campaign deletion via its own
-- ON DELETE SET NULL.
-- ============================================================================

-- ── Enum additions (safe to re-run; nothing below uses the new values) ─────
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_DISPATCHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_RUN_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_RUN_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_RUN_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_RETRY_INITIATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_LEAD_QUOTED';

-- ── email_campaign_runs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_campaign_runs" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARING',
    "snapshot" JSONB NOT NULL,
    "preflight" JSONB,
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "cancelled_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_by_id" TEXT,
    "started_by_name" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_campaign_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_campaign_runs_campaign_id_idx" ON "email_campaign_runs"("campaign_id");
CREATE INDEX IF NOT EXISTS "email_campaign_runs_status_idx" ON "email_campaign_runs"("status");
CREATE INDEX IF NOT EXISTS "email_campaign_runs_started_at_idx" ON "email_campaign_runs"("started_at");

DO $$ BEGIN
  ALTER TABLE "email_campaign_runs"
    ADD CONSTRAINT "email_campaign_runs_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── email_campaign_recipients ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_campaign_recipients" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "customer_id" TEXT,
    "lead_id" TEXT,
    "booking_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "batch_index" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "email_send_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_campaign_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_campaign_recipients_run_id_email_key" ON "email_campaign_recipients"("run_id", "email");
CREATE UNIQUE INDEX IF NOT EXISTS "email_campaign_recipients_email_send_id_key" ON "email_campaign_recipients"("email_send_id");
CREATE INDEX IF NOT EXISTS "email_campaign_recipients_run_id_status_idx" ON "email_campaign_recipients"("run_id", "status");
CREATE INDEX IF NOT EXISTS "email_campaign_recipients_email_idx" ON "email_campaign_recipients"("email");

DO $$ BEGIN
  ALTER TABLE "email_campaign_recipients"
    ADD CONSTRAINT "email_campaign_recipients_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "email_campaign_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── email_automation_enrollments ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_automation_enrollments" (
    "id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "booking_id" TEXT,
    "lead_id" TEXT,
    "customer_id" TEXT,
    "email" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "trigger_snapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "stop_reason" TEXT,
    "current_stage" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3),
    "history" JSONB,
    "last_evaluated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error" TEXT,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_automation_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_automation_enrollments_dedupe_key_key" ON "email_automation_enrollments"("dedupe_key");
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_automation_id_status_idx" ON "email_automation_enrollments"("automation_id", "status");
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_status_next_run_at_idx" ON "email_automation_enrollments"("status", "next_run_at");
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_email_idx" ON "email_automation_enrollments"("email");
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_booking_id_idx" ON "email_automation_enrollments"("booking_id");
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_lead_id_idx" ON "email_automation_enrollments"("lead_id");

DO $$ BEGIN
  ALTER TABLE "email_automation_enrollments"
    ADD CONSTRAINT "email_automation_enrollments_automation_id_fkey"
    FOREIGN KEY ("automation_id") REFERENCES "email_automations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
