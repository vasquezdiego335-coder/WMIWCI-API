-- ════════════════════════════════════════════════════════════════════════════
--  DEPOSIT LINKS: a real move time, and an audience split for the job text.
--  (owner spec 2026-08-20)
--  ------------------------------------------------------------------------
--  FIVE NULLABLE/DEFAULTED COLUMNS ON ONE TABLE. Nothing is dropped, renamed,
--  retyped or back-filled. Every existing deposit_requests row is already
--  correct the instant this runs, and code deployed BEFORE this migration
--  simply never references the new columns — the same posture as
--  20260728214500_lead_move_details.
--
--  WHY move_time_minutes IS AN INTEGER AND NOT PART OF move_date:
--    A move time folded into a timestamp is a time that a timezone can move.
--    Minutes-after-midnight-Eastern cannot be shifted by DST, by a server in
--    UTC, or by the customer's own phone. move_date stays a CALENDAR DATE
--    (anchored at 12:00 UTC); the hour lives here. See src/lib/move-date.ts.
--
--  WHY move_details IS AN ARRAY AND THE NOTES ARE NOT:
--    move_details is a customer-facing LIST rendered as bullets, so it is
--    stored as a list (TEXT[], the same shape as bookings.review_reasons).
--    customer_note is one short customer-facing line they must ACT on
--    ("provide the hardware"), rendered as its own callout so it is not
--    skimmed past inside a list of facts. internal_note is the private crew
--    block and is never selected by the public page's projection.
--
--  NOT APPLIED AUTOMATICALLY. This repo does not run migrations during the
--  build (see nixpacks.toml: Neon build-time connections are flaky). Apply it
--  deliberately:
--      DATABASE_URL="<prod url>" npx prisma migrate deploy
--      npx prisma generate
--
--  DEPLOY ORDER DOES NOT MATTER. app/deposit/[token]/page.tsx reads these
--  columns through a fallback that retries the legacy projection on Postgres
--  42703 / Prisma P2022 ("column does not exist"), so shipping the code before
--  the migration degrades to "no move time, no bullets" instead of 500-ing a
--  customer's payment page. Once this migration is applied the fallback never
--  fires again.
--
--  REVERSAL (fully reversible — no data is derived from these columns):
--    ALTER TABLE "deposit_requests" DROP COLUMN IF EXISTS "move_time_minutes";
--    ALTER TABLE "deposit_requests" DROP COLUMN IF EXISTS "move_details";
--    ALTER TABLE "deposit_requests" DROP COLUMN IF EXISTS "customer_note";
--    ALTER TABLE "deposit_requests" DROP COLUMN IF EXISTS "internal_note";
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "deposit_requests" ADD COLUMN IF NOT EXISTS "move_time_minutes" INTEGER;
ALTER TABLE "deposit_requests" ADD COLUMN IF NOT EXISTS "move_details"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "deposit_requests" ADD COLUMN IF NOT EXISTS "customer_note"     TEXT;
ALTER TABLE "deposit_requests" ADD COLUMN IF NOT EXISTS "internal_note"     TEXT;

-- A move time is minutes after midnight: 0 (12:00 AM) through 1439 (11:59 PM).
-- The application already refuses anything else; this is the database saying so
-- too, so a bad value cannot arrive by any other door.
DO $$ BEGIN
  ALTER TABLE "deposit_requests"
    ADD CONSTRAINT "deposit_requests_move_time_minutes_range"
    CHECK ("move_time_minutes" IS NULL OR ("move_time_minutes" >= 0 AND "move_time_minutes" <= 1439));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
