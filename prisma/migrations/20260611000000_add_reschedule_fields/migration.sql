-- Reschedule tracking on bookings. All additive + nullable (or defaulted),
-- so this is a non-destructive migration safe to run on production.
ALTER TABLE "bookings" ADD COLUMN "previous_requested_date" TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN "reschedule_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bookings" ADD COLUMN "rescheduled_at" TIMESTAMP(3);
