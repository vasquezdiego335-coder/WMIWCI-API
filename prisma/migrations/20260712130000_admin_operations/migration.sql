-- Admin operations dashboard fields (owner spec 2026-07-12).
-- Backward-compatible: EVERY column is nullable, so existing rows read as NULL
-- and nothing is rewritten. Money fields are INTEGER cents (match deposit_amount
-- / travel_fee). Booleans are nullable so "not answered" (NULL) is distinct from
-- an explicit "no" (false).

-- ── Customer: extended contact ──────────────────────────────────────────────
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "preferred_name" TEXT,
  ADD COLUMN IF NOT EXISTS "secondary_phone" TEXT,
  ADD COLUMN IF NOT EXISTS "emergency_contact" TEXT,
  ADD COLUMN IF NOT EXISTS "emergency_contact_phone" TEXT;

-- ── Booking: move details ───────────────────────────────────────────────────
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "bedrooms" INTEGER,
  ADD COLUMN IF NOT EXISTS "estimated_cubic_feet" INTEGER,
  ADD COLUMN IF NOT EXISTS "estimated_weight_lbs" INTEGER,
  ADD COLUMN IF NOT EXISTS "num_boxes" INTEGER,
  ADD COLUMN IF NOT EXISTS "needs_packing" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "needs_unpacking" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "needs_assembly" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "needs_disassembly" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "needs_storage" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "has_piano" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "has_safe" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "has_pool_table" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "has_appliances" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "specialty_items" TEXT,
-- ── Booking: truck operations ───────────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS "truck_reservation_number" TEXT,
  ADD COLUMN IF NOT EXISTS "truck_pickup_time" TEXT,
  ADD COLUMN IF NOT EXISTS "truck_return_address" TEXT,
  ADD COLUMN IF NOT EXISTS "driver_name" TEXT,
  ADD COLUMN IF NOT EXISTS "driver_phone" TEXT,
  ADD COLUMN IF NOT EXISTS "driver_license" TEXT,
  ADD COLUMN IF NOT EXISTS "truck_fuel_policy" TEXT,
  ADD COLUMN IF NOT EXISTS "additional_truck_fees" INTEGER,
-- ── Booking: itemized fees (cents) ──────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS "stair_fee" INTEGER,
  ADD COLUMN IF NOT EXISTS "long_carry_fee" INTEGER,
  ADD COLUMN IF NOT EXISTS "heavy_item_fee" INTEGER,
  ADD COLUMN IF NOT EXISTS "packing_fee" INTEGER,
  ADD COLUMN IF NOT EXISTS "assembly_fee" INTEGER,
  ADD COLUMN IF NOT EXISTS "disassembly_fee" INTEGER,
  ADD COLUMN IF NOT EXISTS "tax_amount" INTEGER,
  ADD COLUMN IF NOT EXISTS "processing_fee" INTEGER,
-- ── Booking: internal operations (staff-entered) ────────────────────────────
  ADD COLUMN IF NOT EXISTS "arrival_window" TEXT,
  ADD COLUMN IF NOT EXISTS "assigned_dispatcher" TEXT,
  ADD COLUMN IF NOT EXISTS "dispatcher_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "crew_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "driver_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "office_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "scheduling_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "travel_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "problem_flags" TEXT,
  ADD COLUMN IF NOT EXISTS "outstanding_tasks" TEXT,
  ADD COLUMN IF NOT EXISTS "completion_progress" INTEGER;
