-- Admin operating system (owner spec 2026-07-13): new AuditAction values for the
-- expense / owner-money / payroll / lead ledgers + price-change and config trails.
-- Isolated in its own migration because Postgres ADD VALUE cannot share a
-- transaction with statements that use the new value (same reason as the
-- BOOKING_DETAILS_UPDATED migration). Additive + backward-compatible: existing
-- audit rows are unaffected.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPENSE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPENSE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPENSE_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPENSE_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPENSE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OWNER_TRANSACTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OWNER_TRANSACTION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OWNER_TRANSACTION_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_PAY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREW_PAID';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEAD_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEAD_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRICE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUSINESS_CONFIG_UPDATED';
