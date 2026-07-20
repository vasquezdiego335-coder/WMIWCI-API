-- ════════════════════════════════════════════════════════════════════════════
--  Phase 1 — JobCrew labor & time-tracking system (owner spec 2026-07-20).
--
--  JobCrew becomes the canonical financial labor record for a customer move
--  (docs/admin/discord-crew-integration.md). Everything here is ADDITIVE:
--  every new column is nullable or carries a default, so existing rows read
--  cleanly and no historical data is rewritten. Safe on a live database.
--
--  Money is integer CENTS. Time is integer MINUTES (the legacy Float
--  actual_hours / scheduled_hours columns are retained and kept in sync as
--  derived mirrors, never as the source of truth).
-- ════════════════════════════════════════════════════════════════════════════

-- ── New enums ───────────────────────────────────────────────────────────────
CREATE TYPE "CrewWorkerType" AS ENUM ('OWNER', 'EMPLOYEE', 'CONTRACTOR', 'TEMP_HELPER');
CREATE TYPE "CrewRole" AS ENUM ('CREW_MEMBER', 'CREW_LEADER', 'DRIVER', 'HELPER', 'OWNER_OPERATOR', 'OTHER');
CREATE TYPE "CrewAssignmentStatus" AS ENUM ('INVITED', 'OFFERED', 'ACCEPTED', 'DECLINED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
CREATE TYPE "TimeEntrySource" AS ENUM ('CLOCK', 'MANUAL', 'IMPORTED', 'OWNER_OVERRIDE', 'DISCORD_WORKFLOW');
CREATE TYPE "LaborApprovalStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');
CREATE TYPE "LaborPaymentStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'VOIDED');
CREATE TYPE "LaborPayModel" AS ENUM ('HOURLY', 'FLAT', 'DAY_RATE', 'UNPAID_OWNER', 'ZERO_CONFIRMED', 'CUSTOM');
CREATE TYPE "TravelPayPolicy" AS ENUM ('UNPAID', 'REGULAR', 'SEPARATE_RATE');

-- ── New audit actions ───────────────────────────────────────────────────────
-- PG 12+ permits ALTER TYPE ... ADD VALUE inside a transaction as long as the
-- new value is not USED in the same transaction. Nothing below inserts one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_ASSIGNMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_ASSIGNMENT_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_ASSIGNMENT_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_ASSIGNMENT_DECLINED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_CLOCK_IN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_CLOCK_OUT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_BREAK_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_HOURS_EDITED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_HOURS_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_HOURS_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_HOURS_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_RATE_SNAPSHOT_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_PAYMENT_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_PAYMENT_VOIDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_ZERO_LABOR_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_OWNER_LABOR_VALUED';

-- ── users: profile defaults that SEED a snapshot (never read retroactively) ──
ALTER TABLE "users" ADD COLUMN "default_flat_rate_cents" INTEGER;
ALTER TABLE "users" ADD COLUMN "worker_type" "CrewWorkerType" NOT NULL DEFAULT 'EMPLOYEE';

-- Existing OWNER users are owners for labor purposes too.
UPDATE "users" SET "worker_type" = 'OWNER' WHERE "role" = 'OWNER';

-- ── business_config: labor policy ───────────────────────────────────────────
ALTER TABLE "business_config" ADD COLUMN "owner_economic_rate_cents" INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE "business_config" ADD COLUMN "overtime_threshold_minutes" INTEGER NOT NULL DEFAULT 480;
ALTER TABLE "business_config" ADD COLUMN "overtime_multiplier_pct" INTEGER NOT NULL DEFAULT 150;
ALTER TABLE "business_config" ADD COLUMN "long_shift_review_minutes" INTEGER NOT NULL DEFAULT 840;

-- ── job_crew: identity ──────────────────────────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN "worker_type" "CrewWorkerType" NOT NULL DEFAULT 'EMPLOYEE';
ALTER TABLE "job_crew" ADD COLUMN "role" "CrewRole" NOT NULL DEFAULT 'CREW_MEMBER';
ALTER TABLE "job_crew" ADD COLUMN "assignment_status" "CrewAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED';
ALTER TABLE "job_crew" ADD COLUMN "crew_job_id" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "accepted_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "declined_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "cancelled_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "cancel_reason" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "assignment_notes" TEXT;

-- Existing rows flagged crew_leader keep that meaning in the new role enum.
UPDATE "job_crew" SET "role" = 'CREW_LEADER' WHERE "crew_leader" = true;

-- ── job_crew: scheduled time ────────────────────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN "scheduled_start_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "scheduled_end_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "scheduled_break_minutes" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "scheduled_minutes" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "scheduled_travel_minutes" INTEGER;

-- ── job_crew: actual time (INTEGER MINUTES) ─────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN "break_started_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "actual_break_minutes" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "worked_minutes" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "regular_minutes" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "overtime_minutes" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "travel_minutes" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "paid_minutes" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "time_entry_source" "TimeEntrySource";
ALTER TABLE "job_crew" ADD COLUMN "time_adjusted_by_id" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "time_adjusted_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "time_adjust_reason" TEXT;

-- Backfill minutes from any legacy Float hours so nothing is lost.
UPDATE "job_crew" SET "worked_minutes" = ROUND("actual_hours" * 60)::INTEGER WHERE "actual_hours" IS NOT NULL;
UPDATE "job_crew" SET "scheduled_minutes" = ROUND("scheduled_hours" * 60)::INTEGER WHERE "scheduled_hours" IS NOT NULL;

-- ── job_crew: pay model + RATE SNAPSHOTS ────────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN "pay_model" "LaborPayModel" NOT NULL DEFAULT 'HOURLY';
ALTER TABLE "job_crew" ADD COLUMN "hourly_rate_cents_snapshot" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "overtime_rate_cents_snapshot" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "flat_pay_cents_snapshot" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "day_rate_cents_snapshot" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "travel_pay_policy" "TravelPayPolicy" NOT NULL DEFAULT 'REGULAR';
ALTER TABLE "job_crew" ADD COLUMN "travel_rate_cents_snapshot" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "economic_rate_cents_snapshot" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "rate_snapshot_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "rate_snapshot_source" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "rate_adjusted_by_id" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "rate_adjusted_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "rate_adjust_reason" TEXT;

-- Freeze any legacy per-job rate/flat pay as a snapshot NOW, so a future profile
-- rate change cannot retroactively alter an existing job's labor cost.
UPDATE "job_crew"
   SET "hourly_rate_cents_snapshot" = "pay_rate",
       "rate_snapshot_at" = COALESCE("assigned_at", CURRENT_TIMESTAMP),
       "rate_snapshot_source" = 'legacy_backfill'
 WHERE "pay_rate" IS NOT NULL;

UPDATE "job_crew"
   SET "flat_pay_cents_snapshot" = "flat_pay",
       "pay_model" = 'FLAT',
       "rate_snapshot_at" = COALESCE("rate_snapshot_at", "assigned_at", CURRENT_TIMESTAMP),
       "rate_snapshot_source" = COALESCE("rate_snapshot_source", 'legacy_backfill')
 WHERE "flat_pay" IS NOT NULL AND "flat_pay" > 0;

-- ── job_crew: bonuses ───────────────────────────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN "driver_bonus_cents_snapshot" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "crew_leader_bonus_cents_snapshot" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "other_bonus_cents" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "other_bonus_reason" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "reimbursement_cents" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "reimbursement_reason" TEXT;

-- ── job_crew: calculated + approved ─────────────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN "calculated_pay_cents" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "approved_pay_cents" INTEGER;
ALTER TABLE "job_crew" ADD COLUMN "approval_status" "LaborApprovalStatus" NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "job_crew" ADD COLUMN "submitted_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "submitted_by_id" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "approved_by_id" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "approved_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "rejected_reason" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "adjustment_reason" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "zero_labor_confirmed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "job_crew" ADD COLUMN "zero_labor_confirmed_by_id" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "zero_labor_confirmed_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN "zero_labor_confirmed_reason" TEXT;

-- Legacy rows that were already marked PAY_APPROVED / PAID were agreed money.
UPDATE "job_crew" SET "approval_status" = 'APPROVED' WHERE "pay_status" IN ('PAY_APPROVED', 'PAID');

-- ── job_crew: payment state ─────────────────────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN "payment_status" "LaborPaymentStatus" NOT NULL DEFAULT 'UNPAID';
UPDATE "job_crew" SET "payment_status" = 'PAID' WHERE "pay_status" = 'PAID';

-- ── job_crew: audit ─────────────────────────────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "created_by_name" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "updated_by_id" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "source_system" TEXT;
ALTER TABLE "job_crew" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "job_crew" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ── labor_payments ──────────────────────────────────────────────────────────
CREATE TABLE "labor_payments" (
    "id" TEXT NOT NULL,
    "job_crew_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paid_on" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "proof_url" TEXT,
    "proof_public_id" TEXT,
    "recorded_by_id" TEXT,
    "recorded_by_name" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_by_id" TEXT,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labor_payments_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "labor_payments"
  ADD CONSTRAINT "labor_payments_job_crew_id_fkey"
  FOREIGN KEY ("job_crew_id") REFERENCES "job_crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "job_crew_crew_job_id_key" ON "job_crew"("crew_job_id");
CREATE INDEX "job_crew_job_id_idx" ON "job_crew"("job_id");
CREATE INDEX "job_crew_user_id_idx" ON "job_crew"("user_id");
CREATE INDEX "job_crew_approval_status_idx" ON "job_crew"("approval_status");
CREATE INDEX "job_crew_payment_status_idx" ON "job_crew"("payment_status");
CREATE INDEX "job_crew_assignment_status_idx" ON "job_crew"("assignment_status");
CREATE INDEX "job_crew_scheduled_start_at_idx" ON "job_crew"("scheduled_start_at");
CREATE INDEX "labor_payments_job_crew_id_idx" ON "labor_payments"("job_crew_id");
CREATE INDEX "labor_payments_paid_on_idx" ON "labor_payments"("paid_on");
CREATE INDEX "labor_payments_voided_idx" ON "labor_payments"("voided");

-- ── Data-integrity constraints ──────────────────────────────────────────────
-- Application validation exists too (src/lib/labor-time.ts), but the database
-- is the last line: a scripted or forged write cannot store impossible labor.
-- All are NOT VALID-free because every predicate below already holds for the
-- backfilled rows above.

ALTER TABLE "job_crew" ADD CONSTRAINT "job_crew_minutes_nonneg" CHECK (
  COALESCE("worked_minutes", 0) >= 0 AND
  COALESCE("regular_minutes", 0) >= 0 AND
  COALESCE("overtime_minutes", 0) >= 0 AND
  COALESCE("travel_minutes", 0) >= 0 AND
  COALESCE("paid_minutes", 0) >= 0 AND
  COALESCE("actual_break_minutes", 0) >= 0 AND
  COALESCE("scheduled_break_minutes", 0) >= 0 AND
  COALESCE("scheduled_minutes", 0) >= 0
);

ALTER TABLE "job_crew" ADD CONSTRAINT "job_crew_rates_nonneg" CHECK (
  COALESCE("hourly_rate_cents_snapshot", 0) >= 0 AND
  COALESCE("overtime_rate_cents_snapshot", 0) >= 0 AND
  COALESCE("flat_pay_cents_snapshot", 0) >= 0 AND
  COALESCE("day_rate_cents_snapshot", 0) >= 0 AND
  COALESCE("travel_rate_cents_snapshot", 0) >= 0 AND
  COALESCE("economic_rate_cents_snapshot", 0) >= 0 AND
  COALESCE("driver_bonus_cents_snapshot", 0) >= 0 AND
  COALESCE("crew_leader_bonus_cents_snapshot", 0) >= 0 AND
  COALESCE("other_bonus_cents", 0) >= 0 AND
  COALESCE("reimbursement_cents", 0) >= 0 AND
  COALESCE("calculated_pay_cents", 0) >= 0 AND
  COALESCE("approved_pay_cents", 0) >= 0
);

-- A clock-out can never precede its clock-in.
ALTER TABLE "job_crew" ADD CONSTRAINT "job_crew_clock_order" CHECK (
  "clock_in" IS NULL OR "clock_out" IS NULL OR "clock_out" >= "clock_in"
);

-- A scheduled window cannot end before it starts.
ALTER TABLE "job_crew" ADD CONSTRAINT "job_crew_schedule_order" CHECK (
  "scheduled_start_at" IS NULL OR "scheduled_end_at" IS NULL OR "scheduled_end_at" >= "scheduled_start_at"
);

-- A confirmed $0 labor record must carry who confirmed it and why.
ALTER TABLE "job_crew" ADD CONSTRAINT "job_crew_zero_labor_documented" CHECK (
  "zero_labor_confirmed" = false OR (
    "zero_labor_confirmed_by_id" IS NOT NULL AND
    "zero_labor_confirmed_reason" IS NOT NULL AND
    length(btrim("zero_labor_confirmed_reason")) > 0
  )
);

-- A payment is a positive amount; a correction is a void + re-record.
ALTER TABLE "labor_payments" ADD CONSTRAINT "labor_payments_amount_positive" CHECK ("amount_cents" > 0);

-- A voided payment must say who voided it and why.
ALTER TABLE "labor_payments" ADD CONSTRAINT "labor_payments_void_documented" CHECK (
  "voided" = false OR (
    "voided_by_id" IS NOT NULL AND
    "void_reason" IS NOT NULL AND
    length(btrim("void_reason")) > 0
  )
);
