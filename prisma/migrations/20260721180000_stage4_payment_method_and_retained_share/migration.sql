-- Stage 4 — D1 (payment method) + D4 (company-retained share).
-- ADDITIVE ONLY. Every column is nullable or defaulted, so this migration is
-- safe to apply to a live database with no downtime and no backfill required.

-- ── D1: Stripe as a first-class payment method ─────────────────────────────
-- CARD already exists and means "a card taken outside Stripe". STRIPE is new.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'STRIPE';

-- ── D1: how the money actually arrived ─────────────────────────────────────
-- Nullable on purpose: historical rows predate the column and their method is
-- genuinely unknown. Never guess a payment method.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "method" "PaymentMethod";

-- ── D4: freeze the retained share on the closeout at finalization ──────────
ALTER TABLE "move_closeouts" ADD COLUMN IF NOT EXISTS "business_retained_bp" INTEGER;

-- ── D4: the 40/30/30 policy as applied to one move, stored on the snapshot ──
ALTER TABLE "financial_snapshots" ADD COLUMN IF NOT EXISTS "business_retained_bp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "financial_snapshots" ADD COLUMN IF NOT EXISTS "business_retained_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "financial_snapshots" ADD COLUMN IF NOT EXISTS "rounding_remainder_cents" INTEGER NOT NULL DEFAULT 0;

-- Reporting and filtering by payment method.
CREATE INDEX IF NOT EXISTS "payments_method_idx" ON "payments"("method");

-- ── D5: auto-created Jobs are now audited ──────────────────────────────────
-- Distinct from JOB_STARTED, which means the crew actually began work.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'JOB_CREATED';
