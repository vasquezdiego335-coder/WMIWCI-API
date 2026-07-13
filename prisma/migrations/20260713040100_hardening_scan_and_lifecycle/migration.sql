-- ============================================================================
-- HARDENING (increment 2.1, owner spec 2026-07-13)
-- Additive only: scan_runs table + reminder lifecycle/accountability columns +
-- one composite index. DO-block guarded (duplicate_object / duplicate_table) —
-- the pattern that survived the earlier production applies. Safe to re-run.
-- NO existing column is dropped, renamed, or retyped; NO historical data moved.
-- ============================================================================

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ScanStatus" AS ENUM ('RUNNING','COMPLETED','FAILED','SKIPPED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ScanTrigger" AS ENUM ('MANUAL','SCHEDULED','API','PAGE_LOAD');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "DismissalScope" AS ENUM ('OCCURRENCE','UNTIL_ENTITY_CHANGES','PERMANENT_RULE_ENTITY');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── reminders: lifecycle + accountability + dismissal scope (all nullable) ──
ALTER TABLE "reminders"
  ADD COLUMN IF NOT EXISTS "assigned_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "assigned_by_name" TEXT,
  ADD COLUMN IF NOT EXISTS "claimed_by_id" TEXT,
  ADD COLUMN IF NOT EXISTS "claimed_by_name" TEXT,
  ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completed_by_id" TEXT,
  ADD COLUMN IF NOT EXISTS "completed_by_name" TEXT,
  ADD COLUMN IF NOT EXISTS "dismissal_scope" "DismissalScope",
  ADD COLUMN IF NOT EXISTS "dismissed_by_id" TEXT,
  ADD COLUMN IF NOT EXISTS "dismissed_by_name" TEXT,
  ADD COLUMN IF NOT EXISTS "entity_fingerprint" TEXT;

CREATE INDEX IF NOT EXISTS "reminders_source_entity_type_source_entity_id_idx"
  ON "reminders"("source_entity_type", "source_entity_id");

-- ── scan_runs: Action Center scan metadata ──────────────────────────────────
DO $$ BEGIN
  CREATE TABLE "scan_runs" (
      "id" TEXT NOT NULL,
      "status" "ScanStatus" NOT NULL DEFAULT 'RUNNING',
      "trigger" "ScanTrigger" NOT NULL,
      "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "completed_at" TIMESTAMP(3),
      "duration_ms" INTEGER,
      "triggered_by_id" TEXT,
      "triggered_by_name" TEXT,
      "rules_evaluated" INTEGER,
      "entities_evaluated" INTEGER,
      "reminders_created" INTEGER,
      "reminders_updated" INTEGER,
      "reminders_reopened" INTEGER,
      "reminders_resolved" INTEGER,
      "reminders_skipped" INTEGER,
      "error_count" INTEGER NOT NULL DEFAULT 0,
      "error_summary" TEXT,
      "worker" TEXT,
      CONSTRAINT "scan_runs_pkey" PRIMARY KEY ("id")
  );
  CREATE INDEX "scan_runs_status_idx" ON "scan_runs"("status");
  CREATE INDEX "scan_runs_started_at_idx" ON "scan_runs"("started_at");
EXCEPTION WHEN duplicate_table THEN null; END $$;
