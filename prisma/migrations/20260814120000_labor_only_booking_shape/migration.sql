-- ══════════════════════════════════════════════════════════════════════════
--  LABOR-ONLY BOOKING SHAPE (owner spec 2026-08-14, booking WMIC-1019)
--
--  A customer-provided-truck job is LABOR SERVICE + MOVE SIZE + ADD-ONS. It is
--  not a bedroom package with a company truck attached. This migration gives
--  those three facts three columns, and gives the review signals the admin was
--  deriving by eye (oversized inventory, unknown assembly scope, COI, photos)
--  somewhere to live.
--
--  HISTORICAL SAFETY — the whole point of this file:
--    • Every column is NULLABLE or has a DEFAULT meaning "not applicable".
--      Nothing is back-filled onto an existing booking.
--    • NOTHING here touches base_rate, total_estimate, travel_fee,
--      truck_addon_amount, final_amount, deposit_amount or discount_percent.
--      Every historical booking keeps the exact money it was quoted.
--    • service_type_key is left NULL on existing rows ON PURPOSE.
--      src/lib/service-shape.ts derives the answer from truck_provider and the
--      "Truck:" line already stored in items_description, so WMIC-1019 reads as
--      Labor Only the moment this ships — without a data migration that could
--      mislabel a job nobody re-checked.
--
--  IF NOT EXISTS throughout: a partially applied run is safe to repeat, and
--  service_type_key is also added by the parked 20260731000000_two_service_types
--  migration, so the two can land in either order.
-- ══════════════════════════════════════════════════════════════════════════

-- ── The three separate facts ──────────────────────────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "service_type_key"         TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "move_size_key"            TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "move_size_changed_at"     TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "move_size_changed_by_id"  TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "move_size_change_reason"  TEXT;

-- ── Disclosed inventory + the size verdict ────────────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "inventory_detail"          JSONB;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "inventory_suggested_size"  TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "inventory_review_required" BOOLEAN NOT NULL DEFAULT false;

-- ── Assembly / disassembly scope (the money stays in assembly_fee/disassembly_fee) ──
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "assembly_items"             TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "disassembly_items"          TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "assembly_scope_known"       BOOLEAN;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "assembly_approval_required" BOOLEAN NOT NULL DEFAULT false;

-- ── Certificate of insurance. TEXT tri-state: 'yes' | 'no' | 'unknown'. ───
--    A boolean cannot say "we have not asked the building yet", which is the
--    state that actually gets a crew turned away at a loading dock.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "coi_required_origin" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "coi_required_dest"   TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "coi_notes"           TEXT;

-- ── Review gates + discount rejections + explicit price-change approval ───
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "photos_review_required"      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "discount_rejected"           JSONB;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "price_change_approved_at"    TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "price_change_approved_by_id" TEXT;

-- Finding every labor-only job, and every booking whose scope still needs a
-- human, are both routine admin queries. Partial indexes keep them cheap
-- without adding weight to rows that are neither.
CREATE INDEX IF NOT EXISTS "bookings_service_type_key_idx"
  ON "bookings" ("service_type_key") WHERE "service_type_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "bookings_inventory_review_idx"
  ON "bookings" ("inventory_review_required") WHERE "inventory_review_required" = true;

-- ── Audit actions for the new owner decisions ────────────────────────────
--    IF NOT EXISTS so a partially applied migration can be re-run safely.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MOVE_SIZE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRICE_CHANGE_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVENTORY_REVIEW_CLEARED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SERVICE_TYPE_CORRECTED';
