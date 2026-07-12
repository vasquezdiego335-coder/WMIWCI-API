-- Add BOOKING_DETAILS_UPDATED to the AuditAction enum. Used by the admin
-- booking-details update route (app/api/admin/bookings/[id]/details/route.ts).
-- Additive + backward-compatible: existing audit rows are unaffected. Runs as
-- its own migration because Postgres ADD VALUE cannot share a transaction with
-- statements that use the new value.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_DETAILS_UPDATED';
