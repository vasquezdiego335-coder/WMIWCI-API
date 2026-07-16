-- Leads admin page: SPAM status + soft-archive + follow-up date.
-- Idempotent; applied deliberately via db:migrate:prod. AuditAction already has
-- LEAD_CREATED + LEAD_STATUS_CHANGED, so no enum change is needed for auditing.

-- Add SPAM to the LeadStatus enum if it isn't there yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'LeadStatus' AND e.enumlabel = 'SPAM'
  ) THEN
    ALTER TYPE "LeadStatus" ADD VALUE 'SPAM';
  END IF;
END$$;

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "follow_up_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual): Postgres cannot drop a single enum value cleanly; leave
-- 'SPAM' in place (harmless). To revert the columns:
--   ALTER TABLE "leads" DROP COLUMN IF EXISTS "follow_up_at",
--     DROP COLUMN IF EXISTS "archived_at";
-- ─────────────────────────────────────────────────────────────────────────────
