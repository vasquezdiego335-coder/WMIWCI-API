-- EMAIL MARKETING ADMIN — audit actions (owner spec 2026-07-21).
--
-- Every operator action in /admin/email-marketing that changes what a CUSTOMER
-- receives writes an audit row. Each gets its own value rather than one generic
-- "email updated" with a discriminator buried in JSON, so "who restored a
-- suppression?" is greppable in the audit log.
--
--   EMAIL_SCHEDULED_CANCELLED  — an operator cancelled a queued send
--   EMAIL_SEND_RETRIED         — an operator deliberately re-drove a send that
--                                had not delivered
--   EMAIL_SUPPRESSION_RESTORED — an operator re-opened mail to a suppressed
--                                address (never permitted for a hard bounce or
--                                a spam complaint)
--   EMAIL_TEST_SENT            — a test send to the configured test recipient
--
-- Additive only. ADD VALUE IF NOT EXISTS is safe to re-run, and no statement in
-- this migration USES a newly added value, so the PostgreSQL same-transaction
-- restriction on new enum values is not triggered.
--
-- COORDINATION NOTE: the Stage 4 financial branch also appends to this enum.
-- Both migrations are pure ADD VALUE IF NOT EXISTS, so they commute — applying
-- them in either order produces the same enum.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_SCHEDULED_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_SEND_RETRIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_SUPPRESSION_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_TEST_SENT';
