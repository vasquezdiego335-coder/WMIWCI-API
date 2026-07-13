-- Hardening (increment 2.1, owner spec 2026-07-13): new AuditAction values for
-- dismissal scopes, restore, financial adjustments, and WORKER_PAY overrides.
-- Isolated per repo convention (ADD VALUE cannot share a transaction with
-- statements that use the new value). Additive + backward-compatible.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REMINDER_DISMISSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REMINDER_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FINANCIAL_ADJUSTMENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKER_PAY_OVERRIDE';
