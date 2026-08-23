-- ═══════════════════════════════════════════════════════════════════════
--  REVIEW STATUS + THE MILEAGE THAT EXPLAINS A CALCULATED TOTAL
--
--  quoteEstimate() has always computed `requiresReview` and then dropped it:
--  the owner saw a price with no indication that a 3BR is a FLOOR pending
--  inventory and access, or that a larger truck was requested. These columns
--  carry the flag and its reasons to the card, the email and the admin.
--
--  quote_mileage_cents / quote_billable_miles exist so a total that DOES
--  include the drive can explain it. They stay NULL while
--  quote_mileage_status = 'pending', which is every quick quote today.
--
--  ADDITIVE AND NULLABLE. No backfill; existing rows read NULL, which is
--  correct — those leads predate the structured snapshot.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_mileage_cents"   INTEGER;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_billable_miles"  INTEGER;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_requires_review" BOOLEAN;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_review_reasons"  TEXT;
