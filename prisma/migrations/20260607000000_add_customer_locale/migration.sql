-- Add a per-customer preferred language for bilingual email + SMS.
-- Safe + additive: NOT NULL with a default, so existing rows backfill to 'en'.
ALTER TABLE "customers"
ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';
