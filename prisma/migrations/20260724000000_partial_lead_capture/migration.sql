-- ============================================================================
-- PARTIAL BOOKING LEAD CAPTURE + MARKETING CONSENT (owner spec 2026-07-24)
--
-- Additive + idempotent. Adds:
--   • enum LeadLifecycle           — partial-lead lifecycle, SEPARATE from the
--                                     CRM LeadStatus (which is untouched)
--   • leads.booking_session_id     — PRIMARY dedup key for partial capture (+idx)
--   • leads.form_step              — furthest booking step reached
--   • leads.lifecycle              — LeadLifecycle (null on all existing leads)
--   • leads.email_marketing_consent (NULLABLE tri-state), + consent metadata
--   • customers.email_marketing_consent (NULLABLE tri-state) + consent_at
--
-- NOTHING EXISTING IS ALTERED DESTRUCTIVELY. No column is dropped, no type is
-- narrowed, no applied migration is rewritten. Every new column is NULLABLE, so
-- this applies safely ahead of the code that uses it and is inert while the
-- PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED flag is off.
--
-- CONSENT SEMANTICS (why nullable, not a boolean default):
--   email_marketing_consent is TRI-STATE — null = the person never expressed a
--   choice, true = deliberate opt-in, false = explicit withdrawal. A default of
--   false would falsely record "declined" for every existing row and every
--   visitor who simply typed an email, which is exactly the consent the owner
--   spec forbids inferring. Promotional audiences require an explicit true.
-- ============================================================================

-- ── New enum (idempotent create) ───────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "LeadLifecycle" AS ENUM (
    'PARTIAL',
    'IN_PROGRESS',
    'SUBMITTED',
    'CONVERTED',
    'ABANDONED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── leads: partial-capture + consent columns ───────────────────────────────
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "booking_session_id" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "form_step" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lifecycle" "LeadLifecycle";
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "email_marketing_consent" BOOLEAN;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "marketing_consent_at" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "marketing_consent_source" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "marketing_consent_version" TEXT;

CREATE INDEX IF NOT EXISTS "leads_booking_session_id_idx" ON "leads"("booking_session_id");

-- ── customers: durable promotional consent (propagated on conversion) ──────
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "email_marketing_consent" BOOLEAN;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "marketing_consent_at" TIMESTAMP(3);
