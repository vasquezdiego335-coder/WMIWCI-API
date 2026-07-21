-- Stage 4 — the 40/30/30 allocation frozen onto FinancialSnapshot, plus the
-- audit vocabulary for an internal-test rehearsal (D3).
--
-- ADDITIVE ONLY: three nullable columns and one enum value. Safe on a live
-- database, no backfill, no downtime.
--
-- Snapshots written before this migration keep NULL here. They are restated
-- from their existing frozen amounts (see profit-allocation.allocationFromSnapshot)
-- and are never re-derived from live configuration.

-- The resolved lines AS PRESENTED at finalization, so a report, an export or a
-- printed summary can restate a closed move years later without consulting the
-- current policy.
ALTER TABLE "financial_snapshots" ADD COLUMN IF NOT EXISTS "allocation_lines" JSONB;
-- WHERE the retained rate came from, and WHICH configuration produced it.
ALTER TABLE "financial_snapshots" ADD COLUMN IF NOT EXISTS "config_source" TEXT;
ALTER TABLE "financial_snapshots" ADD COLUMN IF NOT EXISTS "config_version" TEXT;

-- A rehearsal is recorded distinctly from a real override so synthetic activity
-- is findable without parsing override reasons.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSEOUT_REHEARSAL';
