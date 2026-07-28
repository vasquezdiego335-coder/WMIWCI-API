-- ═══════════════════════════════════════════════════════════════════════════
--  CONSENT EVIDENCE + CAPTURE-SURFACE SOURCES (owner spec 2026-07-28)
--
--  NON-DESTRUCTIVE. Two nullable columns and fourteen new enum values. No
--  column is dropped, no enum value is removed or renamed, no row is written
--  or rewritten. Existing leads keep whatever source they already have.
--
--  WHY THE COLUMNS: the Lead table has recorded consent SOURCE and VERSION
--  since 2026-07-24; Customer recorded only the boolean and a timestamp. A
--  customer who consented on the booking form without a prior lead therefore
--  had a bare `true` with nothing behind it — not enough to show WHERE they
--  agreed or WHAT wording they were shown if the send is ever questioned.
--
--  WHY THE ENUM VALUES: the existing values describe the marketing CHANNEL a
--  person arrived from (Google, a door hanger, a referral). The new ones
--  describe the capture SURFACE they submitted on. Both are real and they are
--  not the same axis — forcing them into one column is what left the table
--  full of `OTHER`. The channel values are untouched.
--
--  NOTE ON ALTER TYPE: PostgreSQL 12+ permits ADD VALUE inside a transaction
--  provided the new value is not USED in that same transaction. Nothing here
--  writes a row, so this is safe on Neon.
--
--  Rollback: drop the two columns. Enum values cannot be removed in Postgres
--  without recreating the type; leaving them unused is harmless.
-- ═══════════════════════════════════════════════════════════════════════════

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadSource" ADD VALUE 'HOMEPAGE_ESTIMATE';
ALTER TYPE "LeadSource" ADD VALUE 'QUICK_QUOTE_FORM';
ALTER TYPE "LeadSource" ADD VALUE 'BOOKING_FORM';
ALTER TYPE "LeadSource" ADD VALUE 'SERVICES_PAGE';
ALTER TYPE "LeadSource" ADD VALUE 'CONTACT_FORM';
ALTER TYPE "LeadSource" ADD VALUE 'MOVING_CHECKLIST';
ALTER TYPE "LeadSource" ADD VALUE 'GOOGLE_BUSINESS';
ALTER TYPE "LeadSource" ADD VALUE 'FACEBOOK_MARKETPLACE';
ALTER TYPE "LeadSource" ADD VALUE 'DOOR_HANGER_QR';
ALTER TYPE "LeadSource" ADD VALUE 'YARD_SIGN_QR';
ALTER TYPE "LeadSource" ADD VALUE 'CUSTOMER_REFERRAL';
ALTER TYPE "LeadSource" ADD VALUE 'MANUAL_ENTRY';
ALTER TYPE "LeadSource" ADD VALUE 'EXISTING_CUSTOMER_OPT_IN';
ALTER TYPE "LeadSource" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "marketing_consent_source" TEXT,
ADD COLUMN     "marketing_consent_version" TEXT;

