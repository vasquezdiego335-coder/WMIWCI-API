-- Admin operations dashboard fields (owner spec 2026-07-12).
-- Backward-compatible: EVERY column is nullable, so existing rows read as NULL
-- and nothing is rewritten. Money fields are INTEGER cents (match deposit_amount
-- / travel_fee). Booleans are nullable so "not answered" (NULL) is distinct from
-- an explicit "no" (false).

-- ── Customer: extended contact ──────────────────────────────────────────────
ALTER TABLE "customers"
  ADD COLUMN "preferred_name" TEXT,
  ADD COLUMN "secondary_phone" TEXT,
  ADD COLUMN "emergency_contact" TEXT,
  ADD COLUMN "emergency_contact_phone" TEXT;

-- ── Booking: move details ───────────────────────────────────────────────────
ALTER TABLE "bookings"
  ADD COLUMN "bedrooms" INTEGER,
  ADD COLUMN "estimated_cubic_feet" INTEGER,
  ADD COLUMN "estimated_weight_lbs" INTEGER,
  ADD COLUMN "num_boxes" INTEGER,
  ADD COLUMN "needs_packing" BOOLEAN,
  ADD COLUMN "needs_unpacking" BOOLEAN,
  ADD COLUMN "needs_assembly" BOOLEAN,
  ADD COLUMN "needs_disassembly" BOOLEAN,
  ADD COLUMN "needs_storage" BOOLEAN,
  ADD COLUMN "has_piano" BOOLEAN,
  ADD COLUMN "has_safe" BOOLEAN,
  ADD COLUMN "has_pool_table" BOOLEAN,
  ADD COLUMN "has_appliances" BOOLEAN,
  ADD COLUMN "specialty_items" TEXT,
-- ── Booking: truck operations ───────────────────────────────────────────────
  ADD COLUMN "truck_reservation_number" TEXT,
  ADD COLUMN "truck_pickup_time" TEXT,
  ADD COLUMN "truck_return_address" TEXT,
  ADD COLUMN "driver_name" TEXT,
  ADD COLUMN "driver_phone" TEXT,
  ADD COLUMN "driver_license" TEXT,
  ADD COLUMN "truck_fuel_policy" TEXT,
  ADD COLUMN "additional_truck_fees" INTEGER,
-- ── Booking: itemized fees (cents) ──────────────────────────────────────────
  ADD COLUMN "stair_fee" INTEGER,
  ADD COLUMN "long_carry_fee" INTEGER,
  ADD COLUMN "heavy_item_fee" INTEGER,
  ADD COLUMN "packing_fee" INTEGER,
  ADD COLUMN "assembly_fee" INTEGER,
  ADD COLUMN "disassembly_fee" INTEGER,
  ADD COLUMN "tax_amount" INTEGER,
  ADD COLUMN "processing_fee" INTEGER,
-- ── Booking: internal operations (staff-entered) ────────────────────────────
  ADD COLUMN "arrival_window" TEXT,
  ADD COLUMN "assigned_dispatcher" TEXT,
  ADD COLUMN "dispatcher_notes" TEXT,
  ADD COLUMN "crew_notes" TEXT,
  ADD COLUMN "driver_notes" TEXT,
  ADD COLUMN "office_notes" TEXT,
  ADD COLUMN "scheduling_notes" TEXT,
  ADD COLUMN "travel_notes" TEXT,
  ADD COLUMN "problem_flags" TEXT,
  ADD COLUMN "outstanding_tasks" TEXT,
  ADD COLUMN "completion_progress" INTEGER;
