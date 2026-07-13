-- ============================================================================
-- ADMIN OPERATING SYSTEM — the money spine (owner spec 2026-07-13)
-- Every dollar connects to a JOB (Expense.booking_id set), an OWNER transaction
-- (owner_transactions), or a GENERAL business expense (Expense.booking_id null).
--
-- Fully additive + idempotent (CREATE ... IF NOT EXISTS, DO-block-guarded enums
-- and FK). Safe to apply on the live DB and safe to re-run — matches the
-- deliberate `npx prisma migrate deploy` (locally, against prod URL) workflow.
-- Money columns are INTEGER cents to match deposit_amount / travel_fee.
-- ============================================================================

-- ── Enums (guarded so a re-run is a no-op) ─────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ExpenseCategory" AS ENUM ('WORKER_PAY','GAS','TOLLS','PARKING','TRUCK_RENTAL','MOVING_EQUIPMENT','MOVING_BLANKETS','STRAPS_DOLLIES','ADVERTISING','WEBSITE_SOFTWARE','INSURANCE','PHONE','CREW_FOOD','REFUNDS','OFFICE','LEGAL_REGISTRATION','SUPPLIES','MISC');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ExpenseStatus" AS ENUM ('SUBMITTED','NEEDS_REVIEW','APPROVED','REJECTED','REIMBURSED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM ('CASH','CARD','ZELLE','VENMO','CASHAPP','BANK_TRANSFER','CHECK','OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "OwnerTransactionType" AS ENUM ('CONTRIBUTION','WITHDRAWAL','REIMBURSEMENT','DISTRIBUTION','PERSONAL_PURCHASE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadSource" AS ENUM ('GOOGLE','FACEBOOK','INSTAGRAM','DOOR_HANGER','YARD_SIGN','REFERRAL','CRAIGSLIST','OFFERUP','RETURNING_CUSTOMER','WEBSITE','OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadStatus" AS ENUM ('NEW','CONTACTED','QUOTE_SENT','FOLLOW_UP','BOOKED','LOST');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadLostReason" AS ENUM ('PRICE_TOO_HIGH','NO_RESPONSE','DATE_UNAVAILABLE','CHOSE_COMPETITOR','NEEDED_IMMEDIATE','OUTSIDE_SERVICE_AREA','OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CrewPayStatus" AS ENUM ('SCHEDULED','CHECKED_IN','WORKING','COMPLETED','PAY_APPROVED','PAID');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── users: HR / payroll defaults ────────────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "pay_rate" INTEGER,
  ADD COLUMN IF NOT EXISTS "preferred_role" TEXT,
  ADD COLUMN IF NOT EXISTS "emergency_contact" TEXT,
  ADD COLUMN IF NOT EXISTS "emergency_contact_phone" TEXT,
  ADD COLUMN IF NOT EXISTS "reliability_rating" INTEGER,
  ADD COLUMN IF NOT EXISTS "performance_notes" TEXT;

-- ── job_crew: payroll + time tracking ───────────────────────────────────────
ALTER TABLE "job_crew"
  ADD COLUMN IF NOT EXISTS "crew_leader" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "scheduled_hours" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "actual_hours" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "clock_in" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "clock_out" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "break_minutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "pay_rate" INTEGER,
  ADD COLUMN IF NOT EXISTS "flat_pay" INTEGER,
  ADD COLUMN IF NOT EXISTS "tips" INTEGER,
  ADD COLUMN IF NOT EXISTS "bonus" INTEGER,
  ADD COLUMN IF NOT EXISTS "deductions" INTEGER,
  ADD COLUMN IF NOT EXISTS "pay_method" "PaymentMethod",
  ADD COLUMN IF NOT EXISTS "pay_status" "CrewPayStatus" NOT NULL DEFAULT 'SCHEDULED',
  ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pay_notes" TEXT;

-- ── expenses (job-linked OR general business) ───────────────────────────────
DO $$ BEGIN
  CREATE TABLE "expenses" (
      "id" TEXT NOT NULL,
      "amount" INTEGER NOT NULL,
      "incurred_on" TIMESTAMP(3) NOT NULL,
      "category" "ExpenseCategory" NOT NULL,
      "vendor" TEXT,
      "payment_method" "PaymentMethod",
      "paid_by" TEXT,
      "booking_id" TEXT,
      "purpose" TEXT,
      "receipt_url" TEXT,
      "receipt_public_id" TEXT,
      "reimbursable" BOOLEAN NOT NULL DEFAULT false,
      "status" "ExpenseStatus" NOT NULL DEFAULT 'SUBMITTED',
      "notes" TEXT,
      "created_by_id" TEXT,
      "created_by_name" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
  );
  CREATE INDEX "expenses_booking_id_idx" ON "expenses"("booking_id");
  CREATE INDEX "expenses_category_idx" ON "expenses"("category");
  CREATE INDEX "expenses_status_idx" ON "expenses"("status");
  CREATE INDEX "expenses_incurred_on_idx" ON "expenses"("incurred_on");
EXCEPTION WHEN duplicate_table THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── owner_transactions (Diego / Sebastian personal money) ───────────────────
DO $$ BEGIN
  CREATE TABLE "owner_transactions" (
      "id" TEXT NOT NULL,
      "owner" "TaskOwner" NOT NULL,
      "amount" INTEGER NOT NULL,
      "type" "OwnerTransactionType" NOT NULL,
      "occurred_on" TIMESTAMP(3) NOT NULL,
      "payment_method" "PaymentMethod",
      "explanation" TEXT,
      "receipt_url" TEXT,
      "receipt_public_id" TEXT,
      "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
      "booking_id" TEXT,
      "created_by_id" TEXT,
      "created_by_name" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "owner_transactions_pkey" PRIMARY KEY ("id")
  );
  CREATE INDEX "owner_transactions_owner_idx" ON "owner_transactions"("owner");
  CREATE INDEX "owner_transactions_type_idx" ON "owner_transactions"("type");
  CREATE INDEX "owner_transactions_occurred_on_idx" ON "owner_transactions"("occurred_on");
EXCEPTION WHEN duplicate_table THEN null; END $$;

-- ── leads (sales pipeline + marketing-source attribution) ───────────────────
DO $$ BEGIN
  CREATE TABLE "leads" (
      "id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "phone" TEXT,
      "email" TEXT,
      "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
      "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
      "lost_reason" "LeadLostReason",
      "estimated_value" INTEGER,
      "job_type" TEXT,
      "move_date" TIMESTAMP(3),
      "zip" TEXT,
      "notes" TEXT,
      "assigned_to" TEXT,
      "converted_booking_id" TEXT,
      "contacted_at" TIMESTAMP(3),
      "quoted_at" TIMESTAMP(3),
      "booked_at" TIMESTAMP(3),
      "lost_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
  );
  CREATE INDEX "leads_status_idx" ON "leads"("status");
  CREATE INDEX "leads_source_idx" ON "leads"("source");
  CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");
EXCEPTION WHEN duplicate_table THEN null; END $$;

-- ── business_config (single row: ownership split + cash reserves) ───────────
DO $$ BEGIN
  CREATE TABLE "business_config" (
      "id" TEXT NOT NULL DEFAULT 'singleton',
      "diego_split_percent" INTEGER NOT NULL DEFAULT 50,
      "sebastian_split_percent" INTEGER NOT NULL DEFAULT 50,
      "tax_reserve_percent" INTEGER NOT NULL DEFAULT 25,
      "emergency_reserve_cents" INTEGER NOT NULL DEFAULT 0,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "business_config_pkey" PRIMARY KEY ("id")
  );
EXCEPTION WHEN duplicate_table THEN null; END $$;
