-- Stage 4 — D6: owner and crew labor-rate configuration.
--
-- ADDITIVE ONLY. Every column is nullable or defaulted, so this is safe on a
-- live database: no backfill, no downtime, and the currently deployed app keeps
-- working if this lands before the code does.
--
-- DELIBERATELY NOT BACKFILLED: an owner labor rate that nobody has typed in is
-- UNKNOWN, and writing a guess here would be indistinguishable from a rate the
-- owner actually chose. Missing stays missing until a human sets it.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "owner_economic_rate_cents" INTEGER;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "default_pay_model" "LaborPayModel";
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rate_effective_on" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rate_notes" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rate_updated_by_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rate_updated_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_drive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_lead_crew" BOOLEAN NOT NULL DEFAULT false;

-- A rate change is owner-financial authority and is audited with both values.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LABOR_RATE_CONFIGURED';
