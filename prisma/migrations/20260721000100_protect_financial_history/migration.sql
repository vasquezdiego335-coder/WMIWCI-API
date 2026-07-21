-- P1-2 — stop a booking deletion from destroying immutable financial history.
--
-- As shipped in Stage 2 the chain was:
--     bookings -> move_closeouts (ON DELETE CASCADE)
--              -> financial_snapshots (ON DELETE CASCADE)
--
-- so `prisma.booking.delete(...)` silently destroyed the MoveCloseout AND every
-- FinancialSnapshot for that move — the immutable record Stage 2 exists to
-- protect, captured under settings that have since changed and therefore NOT
-- recomputable. Two live delete paths exist (the Stripe-failure rollback in
-- app/api/bookings/route.ts and the internal test-booking cleanup). Neither is
-- exploitable today, because a seconds-old booking cannot have a closeout, but
-- the constraint made future data loss a one-line change away.
--
-- RESTRICT makes the database refuse: a booking that carries financial history
-- cannot be deleted at all. The rollback path still works, because it only ever
-- deletes a booking that never got as far as a closeout.
--
-- The closeout -> snapshots cascade is deliberately LEFT ALONE. Nothing in the
-- codebase deletes a MoveCloseout (reopening supersedes, it does not delete),
-- and if a closeout is ever legitimately removed its snapshots should go with
-- it. The dangerous edge was the booking, and that is the one being closed.
--
-- Additive and reversible: no data is read, written or dropped.

ALTER TABLE "move_closeouts"
  DROP CONSTRAINT IF EXISTS "move_closeouts_booking_id_fkey";

ALTER TABLE "move_closeouts"
  ADD CONSTRAINT "move_closeouts_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- OwnerDistribution.booking_id was always FK-free by design, so distributions
-- already survive a booking deletion. Recorded here so the asymmetry reads as
-- intentional rather than as an oversight.
