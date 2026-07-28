-- ═══════════════════════════════════════════════════════════════════════════
--  EMAIL AGENT HARDENING — additive migration (owner spec 2026-07-28)
--
--  NON-DESTRUCTIVE. Every statement is ADD COLUMN (with a default) or CREATE
--  INDEX, on the email_agent_* tables only. No column is dropped or renamed,
--  no table outside the agent is touched, and no row is written or deleted.
--  Existing agent records keep their history and acquire the new columns at
--  their defaults — provenance reads "unknown" for records written before the
--  boundary existed, which is the honest value for them.
--
--  What it adds:
--    * provenance (environment/service/source/deployment) so a record from a
--      laptop is distinguishable from a production worker cycle;
--    * AI investigation state (evidence hash, last-investigated, cooldown) so
--      an unchanged incident stops costing a model call every cycle;
--    * cost accounting (cached + reasoning tokens, estimated USD, pricing
--      version, fallback flag) on every model call;
--    * budget and blast-radius ceilings on the settings singleton;
--    * exactly-once execution stamps on approvals.
--
--  Rollback: DROP the added columns and indexes. Nothing else is affected.
-- ═══════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "email_agent_settings" ADD COLUMN     "ai_reinvestigate_hours" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "allow_provider_fallback" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "auto_downgrade_reason" TEXT,
ADD COLUMN     "auto_downgraded_at" TIMESTAMP(3),
ADD COLUMN     "auto_failure_downgrade_threshold" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "budget_alert_level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "budget_alert_period" TEXT,
ADD COLUMN     "fallback_model" TEXT,
ADD COLUMN     "fallback_provider" TEXT,
ADD COLUMN     "max_ai_cost_usd_per_day" DOUBLE PRECISION NOT NULL DEFAULT 0.20,
ADD COLUMN     "max_ai_cost_usd_per_month" DOUBLE PRECISION NOT NULL DEFAULT 3.00,
ADD COLUMN     "max_auto_actions_per_day" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "max_auto_actions_per_incident" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "max_auto_actions_per_tool_day" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "max_model_calls_per_cycle" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "max_model_calls_per_day" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "max_tokens_per_day" INTEGER NOT NULL DEFAULT 150000,
ADD COLUMN     "max_tokens_per_month" INTEGER NOT NULL DEFAULT 3000000,
ADD COLUMN     "resource_action_cooldown_minutes" INTEGER NOT NULL DEFAULT 60;

-- AlterTable
ALTER TABLE "email_agent_runs" ADD COLUMN     "ai_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "ai_skipped_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "checks_completed_at" TIMESTAMP(3),
ADD COLUMN     "deployment_id" TEXT,
ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "service" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'scheduled';

-- AlterTable
ALTER TABLE "email_agent_findings" ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'unknown';

-- AlterTable
ALTER TABLE "email_agent_incidents" ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "evidence_hash" TEXT,
ADD COLUMN     "investigated_evidence_hash" TEXT,
ADD COLUMN     "investigation_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_investigated_at" TIMESTAMP(3),
ADD COLUMN     "reinvestigate_requested_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "email_agent_actions" ADD COLUMN     "arguments_hash" TEXT,
ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "service" TEXT NOT NULL DEFAULT 'unknown';

-- AlterTable
ALTER TABLE "email_agent_approvals" ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "executed_at" TIMESTAMP(3),
ADD COLUMN     "executed_by_id" TEXT;

-- AlterTable
ALTER TABLE "email_agent_model_calls" ADD COLUMN     "cached_input_tokens" INTEGER,
ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "estimated_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "fallback_reason" TEXT,
ADD COLUMN     "incident_id" TEXT,
ADD COLUMN     "is_fallback" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pricing_version" TEXT,
ADD COLUMN     "reasoning_tokens" INTEGER;

-- CreateIndex
CREATE INDEX "email_agent_runs_environment_service_started_at_idx" ON "email_agent_runs"("environment", "service", "started_at");

-- CreateIndex
CREATE INDEX "email_agent_incidents_evidence_hash_idx" ON "email_agent_incidents"("evidence_hash");

-- CreateIndex
CREATE INDEX "email_agent_incidents_last_investigated_at_idx" ON "email_agent_incidents"("last_investigated_at");

-- CreateIndex
CREATE INDEX "email_agent_incidents_environment_idx" ON "email_agent_incidents"("environment");

-- CreateIndex
CREATE INDEX "email_agent_actions_environment_started_at_idx" ON "email_agent_actions"("environment", "started_at");

-- CreateIndex
CREATE INDEX "email_agent_actions_tool_name_started_at_idx" ON "email_agent_actions"("tool_name", "started_at");

-- CreateIndex
CREATE INDEX "email_agent_actions_arguments_hash_idx" ON "email_agent_actions"("arguments_hash");

-- CreateIndex
CREATE INDEX "email_agent_model_calls_environment_created_at_idx" ON "email_agent_model_calls"("environment", "created_at");

-- CreateIndex
CREATE INDEX "email_agent_model_calls_incident_id_idx" ON "email_agent_model_calls"("incident_id");

