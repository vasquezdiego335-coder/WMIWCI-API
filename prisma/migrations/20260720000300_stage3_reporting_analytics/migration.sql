-- ════════════════════════════════════════════════════════════════════════════
--  Stage 3 — reporting, marketing profitability, exports (owner spec 2026-07-20).
--
--  Entirely ADDITIVE: new tables, new nullable columns, new indexes. Nothing is
--  altered or dropped, so Stages 0-2 behave identically.
--
--  Money is integer CENTS. Rates are BASIS POINTS.
-- ════════════════════════════════════════════════════════════════════════════

-- ── New enums ───────────────────────────────────────────────────────────────
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "CampaignChannel" AS ENUM ('DOOR_HANGER', 'YARD_SIGN', 'QR_CODE', 'GOOGLE_ADS', 'META_ADS', 'GOOGLE_BUSINESS', 'MARKETPLACE', 'INSTAGRAM', 'EMAIL', 'REFERRAL_PROGRAM', 'PARTNERSHIP', 'WEBSITE', 'PHONE', 'OTHER');
CREATE TYPE "SpendKind" AS ENUM ('PRINT', 'DISTRIBUTION', 'AD_SPEND', 'PLATFORM_FEE', 'CREATIVE', 'ADJUSTMENT', 'OTHER');
CREATE TYPE "ReportExportStatus" AS ENUM ('SUCCESS', 'FAILED');

-- ── New audit actions ───────────────────────────────────────────────────────
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REPORT_EXPORTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SAVED_VIEW_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SAVED_VIEW_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CAMPAIGN_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CAMPAIGN_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CAMPAIGN_SPEND_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ATTRIBUTION_CORRECTED';

-- ── bookings: attribution (all nullable; first-touch is write-once by policy) ──
ALTER TABLE "bookings" ADD COLUMN "first_touch_source" TEXT;
ALTER TABLE "bookings" ADD COLUMN "first_touch_campaign" TEXT;
ALTER TABLE "bookings" ADD COLUMN "first_touch_at" TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN "last_touch_source" TEXT;
ALTER TABLE "bookings" ADD COLUMN "last_touch_campaign" TEXT;
ALTER TABLE "bookings" ADD COLUMN "booking_source" TEXT;
ALTER TABLE "bookings" ADD COLUMN "booking_campaign" TEXT;
ALTER TABLE "bookings" ADD COLUMN "owner_assigned_source" TEXT;
ALTER TABLE "bookings" ADD COLUMN "utm_source" TEXT;
ALTER TABLE "bookings" ADD COLUMN "utm_medium" TEXT;
ALTER TABLE "bookings" ADD COLUMN "utm_campaign" TEXT;
ALTER TABLE "bookings" ADD COLUMN "utm_content" TEXT;
ALTER TABLE "bookings" ADD COLUMN "qr_campaign" TEXT;

-- Seed first-touch from the existing `source` so historical bookings keep their
-- original attribution. This runs ONCE; first-touch is never overwritten again.
UPDATE "bookings"
   SET "first_touch_source" = COALESCE("source", "found_us"),
       "first_touch_at" = "created_at"
 WHERE "first_touch_source" IS NULL
   AND (COALESCE("source", "found_us") IS NOT NULL);

-- ── Reporting indexes (period scans, marketing rollups, city grouping) ───────
CREATE INDEX "bookings_completed_at_idx" ON "bookings"("completed_at");
CREATE INDEX "bookings_source_idx" ON "bookings"("source");
CREATE INDEX "bookings_owner_assigned_source_idx" ON "bookings"("owner_assigned_source");
CREATE INDEX "bookings_origin_city_idx" ON "bookings"("origin_city");

-- ── marketing_campaigns ─────────────────────────────────────────────────────
CREATE TABLE "marketing_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "CampaignChannel" NOT NULL,
    "source_key" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "budget_cents" INTEGER,
    "print_quantity" INTEGER,
    "distribution_area" TEXT,
    "creative_version" TEXT,
    "offer" TEXT,
    "landing_page_url" TEXT,
    "qr_identifier" TEXT,
    "phone_identifier" TEXT,
    "notes" TEXT,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_campaigns_qr_identifier_key" ON "marketing_campaigns"("qr_identifier");
CREATE INDEX "marketing_campaigns_status_idx" ON "marketing_campaigns"("status");
CREATE INDEX "marketing_campaigns_source_key_idx" ON "marketing_campaigns"("source_key");
CREATE INDEX "marketing_campaigns_channel_idx" ON "marketing_campaigns"("channel");

-- ── marketing_spend ─────────────────────────────────────────────────────────
CREATE TABLE "marketing_spend" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "kind" "SpendKind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "incurred_on" TIMESTAMP(3) NOT NULL,
    "vendor" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "receipt_url" TEXT,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_spend_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "marketing_spend_campaign_id_idx" ON "marketing_spend"("campaign_id");
CREATE INDEX "marketing_spend_incurred_on_idx" ON "marketing_spend"("incurred_on");

ALTER TABLE "marketing_spend"
  ADD CONSTRAINT "marketing_spend_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── saved_report_views ──────────────────────────────────────────────────────
CREATE TABLE "saved_report_views" (
    "id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "sort_key" TEXT,
    "sort_dir" TEXT,
    "columns" TEXT[],
    "period_key" TEXT,
    "scope" TEXT,
    "basis" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT NOT NULL,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_report_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_report_views_created_by_id_report_type_name_key" ON "saved_report_views"("created_by_id", "report_type", "name");
CREATE INDEX "saved_report_views_report_type_idx" ON "saved_report_views"("report_type");
CREATE INDEX "saved_report_views_shared_idx" ON "saved_report_views"("shared");

-- ── report_exports (audit of files leaving the building) ─────────────────────
CREATE TABLE "report_exports" (
    "id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "period_label" TEXT NOT NULL,
    "basis_label" TEXT NOT NULL,
    "filters" JSONB,
    "column_keys" TEXT[],
    "record_count" INTEGER NOT NULL,
    "status" "ReportExportStatus" NOT NULL DEFAULT 'SUCCESS',
    "error" TEXT,
    "requested_by_id" TEXT NOT NULL,
    "requested_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_exports_report_type_idx" ON "report_exports"("report_type");
CREATE INDEX "report_exports_requested_by_id_idx" ON "report_exports"("requested_by_id");
CREATE INDEX "report_exports_created_at_idx" ON "report_exports"("created_at");

-- ── Data-integrity constraints ──────────────────────────────────────────────
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_nonneg" CHECK (
  COALESCE("budget_cents", 0) >= 0 AND COALESCE("print_quantity", 0) >= 0
);

ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_date_order" CHECK (
  "start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date"
);

-- Spend may be negative ONLY as an explicit ADJUSTMENT (a refunded print run);
-- every other kind must be a positive cost.
ALTER TABLE "marketing_spend" ADD CONSTRAINT "marketing_spend_amount_sign" CHECK (
  "kind" = 'ADJUSTMENT' OR "amount_cents" >= 0
);

ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_count_nonneg" CHECK ("record_count" >= 0);
