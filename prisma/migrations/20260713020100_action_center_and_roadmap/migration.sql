-- ============================================================================
-- ACTION CENTER + IDEAS & ROADMAP (increment 2, owner spec 2026-07-13)
-- reminders: deterministic rule-generated attention items (deduped, audited,
-- never hard-deleted by owner actions). roadmap_items: structured product /
-- business planning with idempotent seeding (seed_key).
--
-- Fully additive + idempotent. Enums and tables are DO-block guarded
-- (duplicate_object / duplicate_table) — the exact pattern that survived the
-- 20260713000100 production apply. Safe to re-run.
-- ============================================================================

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ReminderSeverity" AS ENUM ('CRITICAL','HIGH','MEDIUM','LOW','INFO');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ReminderStatus" AS ENUM ('OPEN','ACKNOWLEDGED','IN_PROGRESS','SNOOZED','RESOLVED','DISMISSED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ReminderCategory" AS ENUM ('BOOKING_DATA','JOBS_SCHEDULING','FINANCIAL','CUSTOMER_BALANCE','CREW_PAYROLL','LEADS','DATA_QUALITY');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RoadmapStatus" AS ENUM ('IDEA','RESEARCHING','PLANNED','READY','IN_PROGRESS','BLOCKED','COMPLETED','REJECTED','ARCHIVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RoadmapPriority" AS ENUM ('CRITICAL','HIGH','MEDIUM','LOW');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RoadmapCategory" AS ENUM ('FINANCIAL','REPORTS','JOBS','SCHEDULING','PAYROLL','LEADS','MARKETING','CUSTOMERS','PAYMENTS','EQUIPMENT','FLEET','DOCUMENTS','NOTIFICATIONS','SECURITY','AI','WEBSITE','BOOKING_FORM','SYSTEM','OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── reminders ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE "reminders" (
      "id" TEXT NOT NULL,
      "reminder_type" TEXT NOT NULL,
      "category" "ReminderCategory" NOT NULL,
      "title" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "severity" "ReminderSeverity" NOT NULL,
      "status" "ReminderStatus" NOT NULL DEFAULT 'OPEN',
      "source_entity_type" TEXT,
      "source_entity_id" TEXT,
      "source_url" TEXT,
      "dedupe_key" TEXT NOT NULL,
      "due_at" TIMESTAMP(3),
      "snoozed_until" TIMESTAMP(3),
      "assigned_owner" "TaskOwner",
      "created_by" TEXT NOT NULL DEFAULT 'system',
      "internal_note" TEXT,
      "resolution_note" TEXT,
      "metadata" JSONB,
      "acknowledged_at" TIMESTAMP(3),
      "started_at" TIMESTAMP(3),
      "resolved_at" TIMESTAMP(3),
      "dismissed_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
  );
  CREATE UNIQUE INDEX "reminders_dedupe_key_key" ON "reminders"("dedupe_key");
  CREATE INDEX "reminders_status_idx" ON "reminders"("status");
  CREATE INDEX "reminders_severity_idx" ON "reminders"("severity");
  CREATE INDEX "reminders_category_idx" ON "reminders"("category");
  CREATE INDEX "reminders_due_at_idx" ON "reminders"("due_at");
  CREATE INDEX "reminders_assigned_owner_idx" ON "reminders"("assigned_owner");
EXCEPTION WHEN duplicate_table THEN null; END $$;

-- ── roadmap_items ────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE "roadmap_items" (
      "id" TEXT NOT NULL,
      "seed_key" TEXT,
      "title" TEXT NOT NULL,
      "summary" TEXT,
      "problem" TEXT,
      "solution" TEXT,
      "benefit" TEXT,
      "risks" TEXT,
      "priority" "RoadmapPriority" NOT NULL DEFAULT 'MEDIUM',
      "status" "RoadmapStatus" NOT NULL DEFAULT 'IDEA',
      "category" "RoadmapCategory" NOT NULL DEFAULT 'OTHER',
      "impact" INTEGER,
      "effort" INTEGER,
      "dependencies" TEXT,
      "blockers" TEXT,
      "assigned_owner" "TaskOwner",
      "target_increment" TEXT,
      "notes" TEXT,
      "comments" JSONB,
      "rejection_reason" TEXT,
      "completed_at" TIMESTAMP(3),
      "created_by" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "roadmap_items_pkey" PRIMARY KEY ("id")
  );
  CREATE UNIQUE INDEX "roadmap_items_seed_key_key" ON "roadmap_items"("seed_key");
  CREATE INDEX "roadmap_items_status_idx" ON "roadmap_items"("status");
  CREATE INDEX "roadmap_items_category_idx" ON "roadmap_items"("category");
  CREATE INDEX "roadmap_items_priority_idx" ON "roadmap_items"("priority");
EXCEPTION WHEN duplicate_table THEN null; END $$;
