-- Stage 5 — crew management and scheduling.
--
-- ADDITIVE ONLY. New enums, new tables, new nullable/defaulted columns on
-- existing tables, and new AuditAction values. Nothing is dropped, altered in
-- place, or backfilled. Safe on a live database with no downtime; the deployed
-- app keeps working if this lands before the code does.
--
-- ROLLBACK RISK: low. Dropping the new tables and columns restores the prior
-- state; no Stage 4 financial data is touched. Enum-VALUE additions cannot be
-- rolled back inside a transaction, but nothing in this migration USES the new
-- values in the same transaction, so a partial failure is safely re-runnable
-- (every statement is guarded with IF NOT EXISTS / duplicate_object).

-- ── New enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "WorkerStatus" AS ENUM ('ACTIVE','INACTIVE','ON_LEAVE','UNAVAILABLE','SUSPENDED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "CrewSkill" AS ENUM ('PACKING','FURNITURE_PROTECTION','ASSEMBLY','HEAVY_ITEMS','STAIR_CARRY','DRIVING','LEAD','LOADING','UNLOADING'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AvailabilityExceptionKind" AS ENUM ('ADMIN_BLOCK','UNAVAILABLE_FULL','UNAVAILABLE_PARTIAL','AVAILABLE_OVERRIDE','VACATION','LEAVE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "InvitationStatus" AS ENUM ('PENDING','ACCEPTED','EXPIRED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── User: Stage 5 crew fields ──────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "worker_status" "WorkerStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "skills" "CrewSkill"[] NOT NULL DEFAULT ARRAY[]::"CrewSkill"[];
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "license_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_drive_customer_vehicle" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "start_date" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivated_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivation_reason" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_by_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_by_id" TEXT;

-- ── JobCrew: Stage 5 scheduling fields ─────────────────────────────────────
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "offered_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "acknowledged_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "acknowledgment_stale_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "decline_reason" TEXT;
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "removed_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "removal_reason" TEXT;
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "no_show_at" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "report_time" TIMESTAMP(3);
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "is_driver" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "worker_visible_notes" TEXT;
ALTER TABLE "job_crew" ADD COLUMN IF NOT EXISTS "private_admin_notes" TEXT;

-- ── availability_rules ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "availability_rules" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "day_of_week" INTEGER NOT NULL,
  "start_minute" INTEGER NOT NULL,
  "end_minute" INTEGER NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
  "effective_from" DATE,
  "effective_to" DATE,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "availability_rules_user_id_day_of_week_idx" ON "availability_rules"("user_id","day_of_week");

-- ── availability_exceptions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "availability_exceptions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "kind" "AvailabilityExceptionKind" NOT NULL,
  "date" DATE NOT NULL,
  "start_minute" INTEGER,
  "end_minute" INTEGER,
  "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
  "reason" TEXT,
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "availability_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "availability_exceptions_user_id_date_idx" ON "availability_exceptions"("user_id","date");
CREATE INDEX IF NOT EXISTS "availability_exceptions_date_idx" ON "availability_exceptions"("date");

-- ── job_staffing_requirements ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "job_staffing_requirements" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "min_workers" INTEGER NOT NULL DEFAULT 1,
  "required_workers" INTEGER NOT NULL DEFAULT 2,
  "preferred_workers" INTEGER,
  "required_drivers" INTEGER NOT NULL DEFAULT 1,
  "requires_lead" BOOLEAN NOT NULL DEFAULT true,
  "required_skills" "CrewSkill"[] NOT NULL DEFAULT ARRAY[]::"CrewSkill"[],
  "estimated_start_at" TIMESTAMP(3),
  "estimated_end_at" TIMESTAMP(3),
  "report_time" TIMESTAMP(3),
  "expected_break_minutes" INTEGER,
  "additional_stops" INTEGER NOT NULL DEFAULT 0,
  "has_stairs" BOOLEAN NOT NULL DEFAULT false,
  "has_elevator" BOOLEAN NOT NULL DEFAULT false,
  "long_carry" BOOLEAN NOT NULL DEFAULT false,
  "heavy_items" BOOLEAN NOT NULL DEFAULT false,
  "packing" BOOLEAN NOT NULL DEFAULT false,
  "assembly" BOOLEAN NOT NULL DEFAULT false,
  "customer_provided_truck" BOOLEAN NOT NULL DEFAULT false,
  "rental_truck_pickup" BOOLEAN NOT NULL DEFAULT false,
  "driving_required" BOOLEAN NOT NULL DEFAULT true,
  "out_of_state" BOOLEAN NOT NULL DEFAULT false,
  "loading_location" TEXT,
  "unloading_location" TEXT,
  "worker_instructions" TEXT,
  "private_notes" TEXT,
  "created_by_id" TEXT,
  "updated_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_staffing_requirements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "job_staffing_requirements_job_id_key" ON "job_staffing_requirements"("job_id");

-- ── crew_invitations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "crew_invitations" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "role" "UserRole" NOT NULL DEFAULT 'CREW',
  "worker_type" "CrewWorkerType" NOT NULL DEFAULT 'EMPLOYEE',
  "initial_rate_cents" INTEGER,
  "initial_skills" "CrewSkill"[] NOT NULL DEFAULT ARRAY[]::"CrewSkill"[],
  "can_drive" BOOLEAN NOT NULL DEFAULT false,
  "token" TEXT NOT NULL,
  "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "invited_by_id" TEXT NOT NULL,
  "accepted_by_user_id" TEXT,
  "accepted_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "cancelled_by_id" TEXT,
  "resent_at" TIMESTAMP(3),
  "resend_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crew_invitations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "crew_invitations_token_key" ON "crew_invitations"("token");
CREATE INDEX IF NOT EXISTS "crew_invitations_email_idx" ON "crew_invitations"("email");
CREATE INDEX IF NOT EXISTS "crew_invitations_status_idx" ON "crew_invitations"("status");

-- ── conflict_overrides ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "conflict_overrides" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "job_crew_id" TEXT,
  "user_id" TEXT,
  "code" TEXT NOT NULL,
  "details" JSONB,
  "reason" TEXT NOT NULL,
  "overridden_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conflict_overrides_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "conflict_overrides_job_id_idx" ON "conflict_overrides"("job_id");
CREATE INDEX IF NOT EXISTS "conflict_overrides_job_crew_id_idx" ON "conflict_overrides"("job_crew_id");

-- ── assignment_notifications ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "assignment_notifications" (
  "id" TEXT NOT NULL,
  "job_crew_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "scheduled_for" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "provider_result" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assignment_notifications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "assignment_notifications_dedupe_key_key" ON "assignment_notifications"("dedupe_key");
CREATE INDEX IF NOT EXISTS "assignment_notifications_job_crew_id_idx" ON "assignment_notifications"("job_crew_id");

-- ── Foreign keys (added separately so a re-run does not fail on existing FKs) ─
DO $$ BEGIN
  ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "job_staffing_requirements" ADD CONSTRAINT "job_staffing_requirements_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── AuditAction values ─────────────────────────────────────────────────────
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STAFF_INVITED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVITATION_RESENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVITATION_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVITATION_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STAFF_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STAFF_REACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STAFF_PROFILE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STAFF_SKILLS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STAFF_DRIVER_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AVAILABILITY_RULE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AVAILABILITY_RULE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AVAILABILITY_RULE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AVAILABILITY_EXCEPTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AVAILABILITY_EXCEPTION_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STAFFING_REQUIREMENT_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_OFFERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_DECLINED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_REPLACED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_DRIVER_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_LEAD_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_NO_SHOW';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONFLICT_OVERRIDDEN';
