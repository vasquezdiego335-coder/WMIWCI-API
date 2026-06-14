ALTER TABLE "bookings"
ADD COLUMN "deposit_paid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "truck_addon_due_on_move_day" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "truck_addon_amount" INTEGER NOT NULL DEFAULT 0;
