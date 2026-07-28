-- Quote-form move details on Lead.
--
-- NON-DESTRUCTIVE: three nullable columns, no data rewritten, no column
-- dropped or retyped. Existing rows read as NULL, and code deployed before
-- this migration simply never references them.
--
-- WHY: the partial-lead write path already produced `originZip` and
-- `destinationZip`, but Lead had neither column -- only a single `zip`, which
-- cannot hold both ends of a move. Prisma rejected the create at runtime and
-- the route is deliberately fail-soft, so the visitor got a 200 and the lead
-- was dropped without a trace. `zip` is left untouched for anything already
-- reading it.
--
-- `move_size` exists because the quick quote form captures a HOME SIZE
-- ("2br"), which was being written into `job_type` alongside real job types
-- like "full-move" and "loading-only". One column holding two vocabularies
-- cannot be grouped by either.

ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "origin_zip"      TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "destination_zip" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "move_size"       TEXT;
