-- Action Center + Ideas & Roadmap (increment 2, owner spec 2026-07-13): new
-- AuditAction values for human reminder actions and roadmap create/edit.
-- Isolated in its own migration because Postgres ADD VALUE cannot share a
-- transaction with statements that use the new value (repo convention).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REMINDER_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ROADMAP_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ROADMAP_UPDATED';
