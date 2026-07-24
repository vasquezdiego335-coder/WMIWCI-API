-- ============================================================================
-- LEAD MODEL GETS ITS OWN TABLE: crm_leads (owner spec 2026-07-24)
--
-- The Neon database is SHARED with the marketing tracker, whose raw-SQL `leads`
-- table (mention_code / source_code / ts / ip / language …) occupies the name
-- the Prisma `Lead` model mapped to. Result: every `prisma.lead.*` call failed
-- with `column leads.status does not exist`, silently breaking ALL API lead
-- features (contact-form capture, "not sure" bookings, lead conversion, and the
-- new partial-lead capture).
--
-- FIX: the Prisma `Lead` model now maps to a dedicated `crm_leads` table. This
-- migration creates it with the FULL schema (existing CRM fields + the partial
-- capture / consent / lifecycle fields). It is purely ADDITIVE and IDEMPOTENT.
-- The marketing tracker's `leads` table is NOT touched, renamed, or dropped.
--
-- Enum types are (re)created under guards so this applies on a fresh database
-- too; on production they already exist and the guards make it a no-op.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "LeadSource" AS ENUM ('GOOGLE','FACEBOOK','INSTAGRAM','DOOR_HANGER','YARD_SIGN','REFERRAL','CRAIGSLIST','OFFERUP','RETURNING_CUSTOMER','WEBSITE','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "LeadStatus" AS ENUM ('NEW','CONTACTED','QUOTE_SENT','FOLLOW_UP','BOOKED','LOST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "LeadLostReason" AS ENUM ('PRICE_TOO_HIGH','NO_RESPONSE','DATE_UNAVAILABLE','CHOSE_COMPETITOR','NEEDED_IMMEDIATE','OUTSIDE_SERVICE_AREA','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "LeadLifecycle" AS ENUM ('PARTIAL','IN_PROGRESS','SUBMITTED','CONVERTED','ABANDONED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "crm_leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "lost_reason" "LeadLostReason",
    "estimated_value" INTEGER,
    "job_type" TEXT,
    "move_date" TIMESTAMP(3),
    "zip" TEXT,
    "notes" TEXT,
    "assigned_to" TEXT,
    "converted_booking_id" TEXT,
    "message" TEXT,
    "origin_city" TEXT,
    "dest_city" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "utm_term" TEXT,
    "landing_page" TEXT,
    "referrer" TEXT,
    "promo_code" TEXT,
    "last_activity_at" TIMESTAMP(3),
    "booking_session_id" TEXT,
    "form_step" TEXT,
    "lifecycle" "LeadLifecycle",
    "email_marketing_consent" BOOLEAN,
    "marketing_consent_at" TIMESTAMP(3),
    "marketing_consent_source" TEXT,
    "marketing_consent_version" TEXT,
    "contacted_at" TIMESTAMP(3),
    "quoted_at" TIMESTAMP(3),
    "booked_at" TIMESTAMP(3),
    "lost_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "crm_leads_status_idx" ON "crm_leads"("status");
CREATE INDEX IF NOT EXISTS "crm_leads_source_idx" ON "crm_leads"("source");
CREATE INDEX IF NOT EXISTS "crm_leads_created_at_idx" ON "crm_leads"("created_at");
CREATE INDEX IF NOT EXISTS "crm_leads_email_idx" ON "crm_leads"("email");
CREATE INDEX IF NOT EXISTS "crm_leads_phone_idx" ON "crm_leads"("phone");
CREATE INDEX IF NOT EXISTS "crm_leads_last_activity_at_idx" ON "crm_leads"("last_activity_at");
CREATE INDEX IF NOT EXISTS "crm_leads_booking_session_id_idx" ON "crm_leads"("booking_session_id");
