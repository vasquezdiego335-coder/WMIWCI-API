-- Moving OS Phase 1 correctness pass — Booking.staffing_plan (owner spec
-- 2026-08-12, fix item 1).
--
-- WHY: POST /api/admin/bookings built a crew/truck/hours plan and used it to
-- create the JobStaffingRequirement ONLY when the booking was created CONFIRMED.
-- The default owner path (deposit mode 'stripe_link') creates the booking
-- PENDING_PAYMENT with no Job at all, so the plan was computed and thrown away;
-- by the time approveBooking() upserts the Job, nothing knew what the owner had
-- planned. This column persists that plan on the booking so the requirement can
-- be created on EVERY path with the owner's real numbers.
--
-- ADDITIVE ONLY. One nullable JSONB column on "bookings". Nothing is dropped,
-- altered in place, or backfilled — existing rows read as NULL, which the code
-- treats as "derive an honest plan from the booking's own data".
--
-- ROLLBACK RISK: none. Dropping the column restores the prior state; no
-- financial data is touched. Safe on a live database with no downtime, and the
-- deployed app keeps working if this lands before the code does.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "staffing_plan" JSONB;
