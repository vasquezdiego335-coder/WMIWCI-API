-- Booking access-difficulty flags + readable manual-review reasons.
--
-- WHY: public/booking-form.html has always POSTed five access/inventory answers
-- (difficult elevator and difficult building access at each end, plus the
-- inventory-accuracy attestation). They were absent from the Zod schema in
-- app/api/bookings/route.ts, and z.object() strips unknown keys silently, so
-- every one of those answers was discarded. The form tells the customer these
-- conditions are "Reviewed before any charge applies" — no review could fire.
--
-- reviewReasons replaces a bare manual_review_required boolean that told the
-- owner THAT a job needed review but never WHY.
--
-- SAFETY: purely additive. Every column is nullable or defaulted, so existing
-- rows are valid without a backfill and a rollback is a plain DROP COLUMN.
-- Touches no email, marketing, consent, suppression or campaign table.

ALTER TABLE "bookings"
  ADD COLUMN "difficult_elevator_pickup"     BOOLEAN,
  ADD COLUMN "difficult_elevator_dropoff"    BOOLEAN,
  ADD COLUMN "difficult_building_pickup"     BOOLEAN,
  ADD COLUMN "difficult_building_dropoff"    BOOLEAN,
  ADD COLUMN "inventory_accuracy_confirmed"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "review_reasons"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Owner queue: find everything awaiting review, newest first.
CREATE INDEX IF NOT EXISTS "bookings_manual_review_required_idx"
  ON "bookings" ("manual_review_required", "created_at" DESC);
