-- ============================================================================
-- NOTIFICATION 'DEFERRED' STATUS (2026-07-20) — finding EMAIL-P2-16
--
-- Quiet-hour, frequency-cap and transactional-gap outcomes were recorded as
-- FAILED, so reporting claimed a delivery problem where policy had simply said
-- "send this later". DEFERRED makes the distinction truthful.
--
-- DELIBERATELY ITS OWN MIGRATION. `ALTER TYPE ... ADD VALUE` has historically
-- been rejected inside a transaction block, and Prisma wraps each migration in
-- one. Keeping it alone — and never USING the new label in the same migration —
-- avoids that hazard entirely on every PostgreSQL version.
-- ============================================================================

ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'DEFERRED';
