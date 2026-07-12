-- Late Arrival & Delay Policy (owner spec 2026-07-12): complimentary 30-min
-- grace on crew arrival, then $50 per additional 30-min block, collected on
-- move day (never in the $49 Stripe deposit). Additive + idempotent: every
-- new column is nullable or has a metadata-only DEFAULT (no table rewrite in
-- PG11+). Safe to re-run.

-- ── Bookings: waiting-time tracking + fee (see src/lib/waiting-time.ts) ──
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "crew_arrived_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "customer_ready_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "waiting_started_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "waiting_ended_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "waiting_minutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "waiting_fee" INTEGER,
  ADD COLUMN IF NOT EXISTS "waiting_fee_override" INTEGER,
  ADD COLUMN IF NOT EXISTS "waiting_fee_waived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "waiting_waiver_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "waiting_fee_collected" BOOLEAN NOT NULL DEFAULT false;
