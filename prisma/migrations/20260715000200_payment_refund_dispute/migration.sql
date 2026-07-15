-- ============================================================================
-- PAYMENT REFUND + DISPUTE TRACKING (2026-07-15)
-- Additive + idempotent. Money truth stays in payments.status; these columns
-- record cumulative refunds and dispute state. Safe to apply + re-run.
-- NOTE: ALTER TYPE ... ADD VALUE only ADDS enum labels (never used in this same
-- migration), which is transaction-safe on PostgreSQL 12+.
-- ============================================================================
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "refunded_amount_cents" INTEGER;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_refund_id" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_dispute_id" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "dispute_status" TEXT;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAYMENT_REFUNDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAYMENT_DISPUTED';
