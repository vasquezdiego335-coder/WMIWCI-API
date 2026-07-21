-- P1-3 — audit actions for saved report views.
--
-- SAVED_VIEW_CREATED and SAVED_VIEW_DELETED already existed (Stage 3 defined
-- them and then never wrote the table). These four complete the set so every
-- mutation named in the spec is its own distinguishable event rather than one
-- generic "updated" with a discriminator buried in details.
--
-- Sharing and un-sharing are separate actions on purpose: publishing a view to
-- other users is the security-relevant transition, and it should be greppable
-- in the audit log without decoding a JSON payload.
--
-- Additive only. ADD VALUE IF NOT EXISTS is safe to re-run, and no statement in
-- this migration USES a newly added value, so the PostgreSQL same-transaction
-- restriction on new enum values is not triggered.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SAVED_VIEW_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SAVED_VIEW_RENAMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SAVED_VIEW_SHARED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SAVED_VIEW_UNSHARED';
