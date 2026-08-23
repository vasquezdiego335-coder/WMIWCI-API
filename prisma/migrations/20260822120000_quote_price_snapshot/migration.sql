-- ═══════════════════════════════════════════════════════════════════════
--  THE QUOTE SNAPSHOT (owner spec 2026-08-22)
--
--  `crm_leads.estimated_value` is one ambiguous number. It cannot distinguish a
--  finished price from a package subtotal whose drive has not been measured,
--  and later writes may raise it, so it can never be the auditable record of
--  what was quoted. These columns are that record.
--
--  ADDITIVE AND NULLABLE. Every existing row keeps its estimated_value
--  untouched and simply reports NULL here, which reads correctly as "this
--  lead predates the structured snapshot" — no backfill, no recalculation of
--  historical quotes, no lock beyond the catalogue update.
--
--  TABLE NAME: `crm_leads`, which is what the Prisma `Lead` model maps to
--  (@@map("crm_leads")). A separate, EMPTY, 28-column legacy `leads` table
--  also exists in production, so targeting it applies cleanly and reports
--  success while leaving the real table without these columns — after which
--  every quick-quote capture throws on the missing column, is swallowed by
--  capturePartialLeadSafe, and answers HTTP 200 with the lead gone.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_base_cents"          INTEGER;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_truck_cents"         INTEGER;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_total_cents"         INTEGER;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_included_truck"      TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_mileage_status"      TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_price_book_version"  TEXT;
