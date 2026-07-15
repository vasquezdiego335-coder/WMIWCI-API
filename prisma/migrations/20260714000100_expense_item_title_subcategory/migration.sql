-- ============================================================================
-- Expense readability upgrade (owner spec 2026-07-14) — Item Title + Subcategory
-- + last-edited-by audit stamp. Fully additive + idempotent (ADD COLUMN IF NOT
-- EXISTS): safe to apply on the live DB and safe to re-run, matching the
-- deliberate `npx prisma migrate deploy` (locally, against prod URL) workflow.
--
-- No money columns change. The ExpenseCategory enum is intentionally untouched
-- (it drives the WORKER_PAY double-labor guard and every existing record); the
-- new owner category headings are a presentation layer over the same values.
-- ============================================================================

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "item_title" TEXT,
  ADD COLUMN IF NOT EXISTS "subcategory" TEXT,
  ADD COLUMN IF NOT EXISTS "updated_by_id" TEXT,
  ADD COLUMN IF NOT EXISTS "updated_by_name" TEXT;
