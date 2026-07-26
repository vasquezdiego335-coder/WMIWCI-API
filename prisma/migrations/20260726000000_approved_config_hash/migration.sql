-- ============================================================================
-- APPROVED-CONFIGURATION HASH (owner spec 2026-07-26)
--
-- Additive + idempotent. Adds ONE nullable column:
--   email_campaign_configs.approved_config_hash
--
-- WHY: approval invalidation compared `updated_at > approved_at`, but every
-- write to that row bumps updated_at — including persisting a validation
-- RESULT. So clicking Validate destroyed the approval, the dispatch error told
-- the operator to "re-validate and re-approve", and doing that re-broke it. The
-- only workaround was "do not click Validate after Approve", which is not a
-- workflow. Recording a hash of the SEND-AFFECTING fields at approval time lets
-- the guard compare configurations instead of timestamps.
--
-- NULL is safe and deliberate: rows approved before this column existed fall
-- back to the old timestamp rule, which is conservative — it asks for a
-- re-approval rather than assuming a stale approval still covers the content.
-- ============================================================================

ALTER TABLE "email_campaign_configs" ADD COLUMN IF NOT EXISTS "approved_config_hash" TEXT;
