-- ============================================================================
-- EMAIL MARKETING ADMIN (owner spec 2026-07-21)
--
-- Additive + idempotent. Adds:
--   • 5 CampaignStatus values for the EMAIL campaign lifecycle
--   • 10 AuditAction values for owner actions in the email admin
--   • email_sends.campaign_id  — the DIRECT campaign relation (SET NULL)
--   • email_sends.is_test      — excludes admin test sends from every number
--   • email_sends.journey_config_version — the config in force when scheduled
--   • email_audiences          — validated audience definitions
--   • email_campaign_configs   — the EMAIL specifics of a marketing_campaign
--   • email_journey_configs    — owner overrides for a lifecycle journey
--   • email_automations        — automation definitions
--   • email_automation_versions — immutable versioned definitions
--
-- NOTHING EXISTING IS ALTERED DESTRUCTIVELY. No column is dropped, no type is
-- narrowed, no applied migration is rewritten. Every new column is nullable or
-- carries a default, so this applies safely ahead of the code that uses it.
--
-- DELETE POLICY, stated explicitly because it is the one that matters:
--   email_sends.campaign_id is ON DELETE SET NULL. Deleting or archiving a
--   campaign must NEVER destroy the record that an email was sent to a real
--   person. The send row survives; its legacy `campaign` string still names
--   what it belonged to.
-- ============================================================================

-- ── Enum additions ─────────────────────────────────────────────────────────
-- Safe to re-run, and no statement below USES a newly added value, so the
-- PostgreSQL same-transaction restriction on new enum values is not triggered.
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'VALIDATING';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'READY';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_CAMPAIGN_STATE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_AUDIENCE_SAVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_AUDIENCE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_JOURNEY_CONFIG_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_JOURNEY_CONFIG_RESET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_AUTOMATION_SAVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_AUTOMATION_STATE_CHANGED';

-- ── email_sends: campaign relation, test flag, journey config version ──────
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "campaign_id" TEXT;
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "journey_config_version" INTEGER;

CREATE INDEX IF NOT EXISTS "email_sends_campaign_id_idx" ON "email_sends"("campaign_id");
CREATE INDEX IF NOT EXISTS "email_sends_is_test_idx" ON "email_sends"("is_test");

DO $$ BEGIN
  ALTER TABLE "email_sends"
    ADD CONSTRAINT "email_sends_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- NO BACKFILL IS PERFORMED.
-- `email_sends.campaign` holds a source-key string that MAY match a campaign's
-- source_key — but a match is not proof, and two campaigns can legitimately
-- share a source key over time. Guessing here would fabricate attribution that
-- reporting then presents as fact. Historical rows stay NULL and reporting
-- falls back to the legacy string, which is honest about being a string.

-- ── email_audiences ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_audiences" (
  "id"                  TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "description"         TEXT,
  "definition"          JSONB NOT NULL,
  "last_preview_count"  INTEGER,
  "last_preview_at"     TIMESTAMP(3),
  "created_by_id"       TEXT,
  "created_by_name"     TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_audiences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_audiences_name_key" ON "email_audiences"("name");
CREATE INDEX IF NOT EXISTS "email_audiences_created_at_idx" ON "email_audiences"("created_at");

-- ── email_campaign_configs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_campaign_configs" (
  "id"               TEXT NOT NULL,
  "campaign_id"      TEXT NOT NULL,
  "template"         TEXT NOT NULL,
  "subject"          TEXT,
  "audience_id"      TEXT,
  "scheduled_at"     TIMESTAMP(3),
  "approved_by_id"   TEXT,
  "approved_by_name" TEXT,
  "approved_at"      TIMESTAMP(3),
  "utm_source"       TEXT,
  "utm_medium"       TEXT,
  "utm_campaign"     TEXT,
  "utm_content"      TEXT,
  "discount_code"    TEXT,
  "validation"       JSONB,
  "status_note"      TEXT,
  "dispatched_at"    TIMESTAMP(3),
  "dispatched_count" INTEGER,
  "created_by_id"    TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_campaign_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_campaign_configs_campaign_id_key" ON "email_campaign_configs"("campaign_id");
CREATE INDEX IF NOT EXISTS "email_campaign_configs_audience_id_idx" ON "email_campaign_configs"("audience_id");
CREATE INDEX IF NOT EXISTS "email_campaign_configs_scheduled_at_idx" ON "email_campaign_configs"("scheduled_at");

DO $$ BEGIN
  ALTER TABLE "email_campaign_configs"
    ADD CONSTRAINT "email_campaign_configs_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SET NULL, not CASCADE: deleting an audience must not delete the record of a
-- campaign that used it.
DO $$ BEGIN
  ALTER TABLE "email_campaign_configs"
    ADD CONSTRAINT "email_campaign_configs_audience_id_fkey"
    FOREIGN KEY ("audience_id") REFERENCES "email_audiences"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── email_journey_configs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_journey_configs" (
  "id"              TEXT NOT NULL,
  "journey_key"     TEXT NOT NULL,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "version"         INTEGER NOT NULL DEFAULT 1,
  "config"          JSONB NOT NULL,
  "updated_by_id"   TEXT,
  "updated_by_name" TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_journey_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_journey_configs_journey_key_key" ON "email_journey_configs"("journey_key");

-- A version is a monotonic counter; a zero or negative version would make
-- "which rules scheduled this send?" unanswerable.
DO $$ BEGIN
  ALTER TABLE "email_journey_configs"
    ADD CONSTRAINT "email_journey_configs_version_positive" CHECK ("version" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── email_automations + versions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_automations" (
  "id"              TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "status"          TEXT NOT NULL DEFAULT 'DRAFT',
  "active_version"  INTEGER,
  "created_by_id"   TEXT,
  "created_by_name" TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_automations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_automations_name_key" ON "email_automations"("name");
CREATE INDEX IF NOT EXISTS "email_automations_status_idx" ON "email_automations"("status");

DO $$ BEGIN
  ALTER TABLE "email_automations"
    ADD CONSTRAINT "email_automations_status_known"
    CHECK ("status" IN ('DRAFT','VALIDATING','TEST','ACTIVE','PAUSED','ARCHIVED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "email_automation_versions" (
  "id"              TEXT NOT NULL,
  "automation_id"   TEXT NOT NULL,
  "version"         INTEGER NOT NULL,
  "definition"      JSONB NOT NULL,
  "created_by_id"   TEXT,
  "created_by_name" TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_automation_versions_pkey" PRIMARY KEY ("id")
);
-- The unique pair IS the immutability guarantee: a change writes a NEW version
-- rather than editing one that may already have scheduled real sends.
CREATE UNIQUE INDEX IF NOT EXISTS "email_automation_versions_automation_id_version_key"
  ON "email_automation_versions"("automation_id", "version");
CREATE INDEX IF NOT EXISTS "email_automation_versions_automation_id_idx"
  ON "email_automation_versions"("automation_id");

DO $$ BEGIN
  ALTER TABLE "email_automation_versions"
    ADD CONSTRAINT "email_automation_versions_automation_id_fkey"
    FOREIGN KEY ("automation_id") REFERENCES "email_automations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "email_automation_versions"
    ADD CONSTRAINT "email_automation_versions_version_positive" CHECK ("version" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
