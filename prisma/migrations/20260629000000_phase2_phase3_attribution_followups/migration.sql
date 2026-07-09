-- Phase 2 (attribution) + Phase 3 (follow-up automation) schema.
-- All changes are additive and backward-compatible: new nullable columns, a
-- bool defaulting false, and two new tables. Safe to deploy ahead of the code
-- that uses them (Phase 3 is gated by MARKETING_FOLLOWUPS_ENABLED at runtime).

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "marketing_opt_out" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "found_us" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "followup_ledger" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'both',
    "status" TEXT NOT NULL DEFAULT 'sent',
    "error" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "followup_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "is_positive" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'admin',
    "comment" TEXT,
    "left_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "followup_ledger_booking_id_idx" ON "followup_ledger"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "followup_ledger_booking_id_type_key" ON "followup_ledger"("booking_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_booking_id_key" ON "reviews"("booking_id");

-- CreateIndex
CREATE INDEX "reviews_booking_id_idx" ON "reviews"("booking_id");

-- AddForeignKey
ALTER TABLE "followup_ledger" ADD CONSTRAINT "followup_ledger_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
