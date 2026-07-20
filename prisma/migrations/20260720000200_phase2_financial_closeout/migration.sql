-- ════════════════════════════════════════════════════════════════════════════
--  Phase 2 — financial closeout (owner spec 2026-07-20).
--
--  Turns a completed move into a DURABLE financial record. Entirely ADDITIVE:
--  new tables + new nullable/defaulted columns on business_config. No existing
--  column is altered or dropped, so Phase 0/1 behavior is untouched.
--
--  Money is integer CENTS. Rates are BASIS POINTS (500 = 5.00%).
-- ════════════════════════════════════════════════════════════════════════════

-- ── New enums ───────────────────────────────────────────────────────────────
CREATE TYPE "CloseoutStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'MISSING_INFORMATION', 'READY_FOR_REVIEW', 'READY_TO_FINALIZE', 'FINALIZED', 'REOPENED');
CREATE TYPE "OverheadMethod" AS ENUM ('NONE', 'PER_MOVE', 'PCT_REVENUE', 'PER_LABOR_HOUR', 'MONTHLY_POOL', 'MANUAL');
CREATE TYPE "ReserveKind" AS ENUM ('TAX', 'GENERAL', 'EMERGENCY', 'TRUCK_FUND', 'EQUIPMENT_FUND', 'LICENSING_FUND', 'INSURANCE_FUND', 'MARKETING_FUND', 'GROWTH_FUND', 'RETAINED_EARNINGS', 'OTHER');
CREATE TYPE "SplitMethod" AS ENUM ('EQUAL', 'OWNERSHIP_PERCENT', 'LABOR_FIRST', 'CUSTOM');
CREATE TYPE "DistributionStatus" AS ENUM ('PLANNED', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOIDED');
CREATE TYPE "TruckSource" AS ENUM ('CUSTOMER_PROVIDED', 'COMPANY_OWNED', 'RENTAL', 'THIRD_PARTY', 'NOT_REQUIRED');

-- ── New audit actions ───────────────────────────────────────────────────────
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_FINALIZED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_REOPENED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_OVERRIDE_USED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_TRUCK_SOURCE_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_BALANCE_WRITTEN_OFF';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_DISPUTE_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OVERHEAD_METHOD_SELECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TAX_RESERVE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUSINESS_RESERVE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OWNER_SPLIT_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISTRIBUTION_PLANNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISTRIBUTION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISTRIBUTION_PAID';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISTRIBUTION_VOIDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SNAPSHOT_SUPERSEDED';

-- ── business_config: closeout policy defaults ───────────────────────────────
ALTER TABLE "business_config" ADD COLUMN "overhead_method" "OverheadMethod" NOT NULL DEFAULT 'NONE';
ALTER TABLE "business_config" ADD COLUMN "overhead_per_move_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "business_config" ADD COLUMN "overhead_pct_revenue_bp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "business_config" ADD COLUMN "overhead_per_labor_hour_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "business_config" ADD COLUMN "overhead_monthly_pool_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "business_config" ADD COLUMN "receipt_required_above_cents" INTEGER NOT NULL DEFAULT 2500;
ALTER TABLE "business_config" ADD COLUMN "general_reserve_bp" INTEGER NOT NULL DEFAULT 0;

-- ── move_closeouts ──────────────────────────────────────────────────────────
CREATE TABLE "move_closeouts" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "status" "CloseoutStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "started_at" TIMESTAMP(3),
    "started_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "submitted_by_id" TEXT,
    "finalized_at" TIMESTAMP(3),
    "finalized_by_id" TEXT,
    "reopened_at" TIMESTAMP(3),
    "reopened_by_id" TEXT,
    "reopen_reason" TEXT,
    "overrides" JSONB,
    "notes" TEXT,
    "truck_source" "TruckSource",
    "truck_source_confirmed_at" TIMESTAMP(3),
    "truck_source_confirmed_by_id" TEXT,
    "balance_write_off_cents" INTEGER,
    "balance_write_off_reason" TEXT,
    "dispute_acknowledged_at" TIMESTAMP(3),
    "overhead_method" "OverheadMethod",
    "overhead_amount_cents" INTEGER,
    "overhead_reason" TEXT,
    "tax_reserve_bp" INTEGER,
    "tax_reserve_cents" INTEGER,
    "tax_reserve_reason" TEXT,
    "split_method" "SplitMethod",
    "split_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "move_closeouts_pkey" PRIMARY KEY ("id")
);

-- ONE closeout per move. There can never be two competing closeouts.
CREATE UNIQUE INDEX "move_closeouts_booking_id_key" ON "move_closeouts"("booking_id");
CREATE INDEX "move_closeouts_status_idx" ON "move_closeouts"("status");
CREATE INDEX "move_closeouts_finalized_at_idx" ON "move_closeouts"("finalized_at");

ALTER TABLE "move_closeouts"
  ADD CONSTRAINT "move_closeouts_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── financial_snapshots ─────────────────────────────────────────────────────
CREATE TABLE "financial_snapshots" (
    "id" TEXT NOT NULL,
    "closeout_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "net_billed_revenue_cents" INTEGER NOT NULL,
    "net_collected_revenue_cents" INTEGER NOT NULL,
    "outstanding_balance_cents" INTEGER NOT NULL,
    "refunded_cents" INTEGER NOT NULL,
    "chargeback_cents" INTEGER NOT NULL,
    "disputed_open_cents" INTEGER NOT NULL,
    "direct_expense_cents" INTEGER NOT NULL,
    "crew_labor_cents" INTEGER NOT NULL,
    "owner_cash_labor_cents" INTEGER NOT NULL,
    "owner_economic_labor_cents" INTEGER NOT NULL,
    "processing_fee_cents" INTEGER NOT NULL,
    "truck_cost_cents" INTEGER NOT NULL,
    "direct_job_cost_cents" INTEGER NOT NULL,
    "cash_gross_profit_cents" INTEGER NOT NULL,
    "economic_profit_cents" INTEGER NOT NULL,
    "allocated_overhead_cents" INTEGER NOT NULL,
    "company_net_profit_cents" INTEGER NOT NULL,
    "economic_net_profit_cents" INTEGER NOT NULL,
    "margin_bp" INTEGER,
    "tax_reserve_cents" INTEGER NOT NULL,
    "business_reserve_cents" INTEGER NOT NULL,
    "retained_earnings_cents" INTEGER NOT NULL,
    "unresolved_liability_cents" INTEGER NOT NULL,
    "distributable_profit_cents" INTEGER NOT NULL,
    "owner_allocations" JSONB,
    "overhead_method" "OverheadMethod" NOT NULL,
    "overhead_rate_raw" INTEGER,
    "tax_reserve_bp" INTEGER,
    "split_method" "SplitMethod",
    "incomplete_flags" JSONB,
    "calculation_version" TEXT NOT NULL,
    "superseded_at" TIMESTAMP(3),
    "superseded_by_id" TEXT,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_snapshots_pkey" PRIMARY KEY ("id")
);

-- One snapshot per version per closeout: reopening makes v2, never a second v1.
CREATE UNIQUE INDEX "financial_snapshots_closeout_id_version_key" ON "financial_snapshots"("closeout_id", "version");
CREATE INDEX "financial_snapshots_booking_id_idx" ON "financial_snapshots"("booking_id");
CREATE INDEX "financial_snapshots_superseded_at_idx" ON "financial_snapshots"("superseded_at");

ALTER TABLE "financial_snapshots"
  ADD CONSTRAINT "financial_snapshots_closeout_id_fkey"
  FOREIGN KEY ("closeout_id") REFERENCES "move_closeouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── reserve_allocations ─────────────────────────────────────────────────────
CREATE TABLE "reserve_allocations" (
    "id" TEXT NOT NULL,
    "closeout_id" TEXT,
    "booking_id" TEXT,
    "kind" "ReserveKind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" TEXT,
    "transferred" BOOLEAN NOT NULL DEFAULT false,
    "transferred_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reserve_allocations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reserve_allocations_closeout_id_idx" ON "reserve_allocations"("closeout_id");
CREATE INDEX "reserve_allocations_kind_idx" ON "reserve_allocations"("kind");

ALTER TABLE "reserve_allocations"
  ADD CONSTRAINT "reserve_allocations_closeout_id_fkey"
  FOREIGN KEY ("closeout_id") REFERENCES "move_closeouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── owner_distributions ─────────────────────────────────────────────────────
CREATE TABLE "owner_distributions" (
    "id" TEXT NOT NULL,
    "owner" "TaskOwner" NOT NULL,
    "booking_id" TEXT,
    "snapshot_id" TEXT,
    "status" "DistributionStatus" NOT NULL DEFAULT 'PLANNED',
    "approved_cents" INTEGER NOT NULL,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "percent_bp" INTEGER,
    "method" "PaymentMethod",
    "paid_on" TIMESTAMP(3),
    "reference" TEXT,
    "notes" TEXT,
    "approved_by_id" TEXT,
    "approved_by_name" TEXT,
    "approved_at" TIMESTAMP(3),
    "recorded_by_id" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_by_id" TEXT,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_distributions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "owner_distributions_owner_idx" ON "owner_distributions"("owner");
CREATE INDEX "owner_distributions_booking_id_idx" ON "owner_distributions"("booking_id");
CREATE INDEX "owner_distributions_status_idx" ON "owner_distributions"("status");

-- ── Data-integrity constraints ──────────────────────────────────────────────
-- Application guards exist too (closeout-guards.ts); the database is the last
-- line so a scripted write cannot store impossible money.

ALTER TABLE "move_closeouts" ADD CONSTRAINT "move_closeouts_nonneg" CHECK (
  COALESCE("balance_write_off_cents", 0) >= 0 AND
  COALESCE("overhead_amount_cents", 0) >= 0 AND
  COALESCE("tax_reserve_cents", 0) >= 0 AND
  COALESCE("tax_reserve_bp", 0) BETWEEN 0 AND 10000
);

-- Reopening must always say why.
ALTER TABLE "move_closeouts" ADD CONSTRAINT "move_closeouts_reopen_documented" CHECK (
  "reopened_at" IS NULL OR ("reopen_reason" IS NOT NULL AND length(btrim("reopen_reason")) > 0)
);

-- Writing off a balance must always say why.
ALTER TABLE "move_closeouts" ADD CONSTRAINT "move_closeouts_writeoff_documented" CHECK (
  "balance_write_off_cents" IS NULL OR "balance_write_off_cents" = 0 OR
  ("balance_write_off_reason" IS NOT NULL AND length(btrim("balance_write_off_reason")) > 0)
);

ALTER TABLE "financial_snapshots" ADD CONSTRAINT "financial_snapshots_version_positive" CHECK ("version" >= 1);

-- Reserves and distributable profit can never be negative; a loss reserves $0.
ALTER TABLE "financial_snapshots" ADD CONSTRAINT "financial_snapshots_nonneg" CHECK (
  "tax_reserve_cents" >= 0 AND
  "business_reserve_cents" >= 0 AND
  "retained_earnings_cents" >= 0 AND
  "unresolved_liability_cents" >= 0 AND
  "distributable_profit_cents" >= 0 AND
  "allocated_overhead_cents" >= 0 AND
  "net_collected_revenue_cents" >= 0 AND
  "outstanding_balance_cents" >= 0 AND
  "refunded_cents" >= 0
);

ALTER TABLE "reserve_allocations" ADD CONSTRAINT "reserve_allocations_amount_nonneg" CHECK ("amount_cents" >= 0);

-- A distribution is a positive amount; you cannot pay more than was approved;
-- percentages stay in range; a void must say why.
ALTER TABLE "owner_distributions" ADD CONSTRAINT "owner_distributions_amounts" CHECK (
  "approved_cents" >= 0 AND
  "paid_cents" >= 0 AND
  "paid_cents" <= "approved_cents" AND
  COALESCE("percent_bp", 0) BETWEEN 0 AND 10000
);

ALTER TABLE "owner_distributions" ADD CONSTRAINT "owner_distributions_void_documented" CHECK (
  "voided" = false OR ("voided_by_id" IS NOT NULL AND "void_reason" IS NOT NULL AND length(btrim("void_reason")) > 0)
);
