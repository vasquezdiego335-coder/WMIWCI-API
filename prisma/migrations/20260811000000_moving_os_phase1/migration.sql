-- Moving OS Phase 1 — fleet trucks + structured inventory + admin Book Move
-- booking columns (owner spec 2026-08-11).
--
-- ADDITIVE ONLY. One new enum, three new tables, new nullable/defaulted columns
-- on "bookings", and two new AuditAction values. Nothing is dropped, altered in
-- place, or backfilled. Safe on a live database with no downtime; the deployed
-- app keeps working if this lands before the code does.
--
-- ROLLBACK RISK: low. Dropping the new tables and columns restores the prior
-- state; no financial data is touched. Enum-VALUE additions cannot be rolled
-- back inside a transaction, but nothing in this migration USES the new values
-- in the same transaction, so a partial failure is safely re-runnable (every
-- statement is guarded with IF NOT EXISTS / duplicate_object).

-- ── New enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "TruckStatus" AS ENUM ('AVAILABLE','MAINTENANCE','RETIRED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── trucks ─────────────────────────────────────────────────────────────────
-- "source" reuses the EXISTING "TruckSource" enum (closeout provenance).
CREATE TABLE IF NOT EXISTS "trucks" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "size" TEXT NOT NULL,
  "source" "TruckSource" NOT NULL DEFAULT 'RENTAL',
  "status" "TruckStatus" NOT NULL DEFAULT 'AVAILABLE',
  "capacity_notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "trucks_pkey" PRIMARY KEY ("id")
);

-- ── inventory_catalog_items ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inventory_catalog_items" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "is_heavy" BOOLEAN NOT NULL DEFAULT false,
  "needs_disassembly" BOOLEAN NOT NULL DEFAULT false,
  "typical_volume_cu_ft" INTEGER,
  "recommended_movers" INTEGER,
  "protection_notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_catalog_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_catalog_items_name_key" ON "inventory_catalog_items"("name");

-- ── booking_inventory_items ────────────────────────────────────────────────
-- name/is_heavy/needs_disassembly are SNAPSHOTS taken at booking time — a
-- later catalog edit must never rewrite what a past move actually carried.
CREATE TABLE IF NOT EXISTS "booking_inventory_items" (
  "id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "catalog_item_id" TEXT,
  "name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "is_heavy" BOOLEAN NOT NULL DEFAULT false,
  "needs_disassembly" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_inventory_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "booking_inventory_items_booking_id_idx" ON "booking_inventory_items"("booking_id");

-- ── Booking: Moving OS Phase 1 columns ─────────────────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "truck_id" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "price_override_reason" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "origin_property_type" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "dest_property_type" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "service_mode" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "coi_required" BOOLEAN NOT NULL DEFAULT false;

-- ── Foreign keys (added separately so a re-run does not fail on existing FKs) ─
DO $$ BEGIN
  ALTER TABLE "bookings" ADD CONSTRAINT "bookings_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "booking_inventory_items" ADD CONSTRAINT "booking_inventory_items_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "booking_inventory_items" ADD CONSTRAINT "booking_inventory_items_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "inventory_catalog_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── AuditAction values ─────────────────────────────────────────────────────
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TRUCK_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TRUCK_UPDATED';
