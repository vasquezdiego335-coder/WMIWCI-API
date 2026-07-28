-- ═══════════════════════════════════════════════════════════════════════════
--  EMAIL OPERATIONS AGENT — additive migration (owner spec 2026-07-27)
--
--  NON-DESTRUCTIVE. This migration only CREATEs. It does not ALTER, DROP or
--  rename any existing table, column, index or constraint, and it writes no
--  rows. Every foreign key it adds points from one new agent table to another
--  new agent table.
--
--  It deliberately adds NO foreign key to marketing_campaigns,
--  email_campaign_runs, email_sends, email_events or users. The agent stores
--  those as retained identifiers (plain text) so that deleting a campaign can
--  never cascade away the record of what the agent did about it.
--
--  Rollback is `DROP TABLE` on the nine email_agent_* tables, in reverse
--  dependency order. Nothing outside those tables is touched.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "email_agent_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" TEXT NOT NULL DEFAULT 'read_only',
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto_actions_enabled" BOOLEAN NOT NULL DEFAULT true,
    "alerts_enabled" BOOLEAN NOT NULL DEFAULT true,
    "digest_warnings" BOOLEAN NOT NULL DEFAULT true,
    "marketing_dispatch_paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_reason" TEXT,
    "paused_at" TIMESTAMP(3),
    "paused_by" TEXT,
    "max_auto_actions_per_run" INTEGER NOT NULL DEFAULT 3,
    "stage_recipient_limit" INTEGER NOT NULL DEFAULT 50,
    "interval_minutes" INTEGER NOT NULL DEFAULT 5,
    "memory_retention_days" INTEGER NOT NULL DEFAULT 365,
    "provider" TEXT,
    "model" TEXT,
    "updated_by_id" TEXT,
    "updated_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_agent_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_agent_runs" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'scheduled',
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL,
    "overall_status" TEXT,
    "checks_run" INTEGER NOT NULL DEFAULT 0,
    "checks_failed" INTEGER NOT NULL DEFAULT 0,
    "findings_total" INTEGER NOT NULL DEFAULT 0,
    "findings_info" INTEGER NOT NULL DEFAULT 0,
    "findings_warning" INTEGER NOT NULL DEFAULT 0,
    "findings_critical" INTEGER NOT NULL DEFAULT 0,
    "incidents_opened" INTEGER NOT NULL DEFAULT 0,
    "incidents_updated" INTEGER NOT NULL DEFAULT 0,
    "incidents_resolved" INTEGER NOT NULL DEFAULT 0,
    "actions_executed" INTEGER NOT NULL DEFAULT 0,
    "approvals_created" INTEGER NOT NULL DEFAULT 0,
    "alerts_sent" INTEGER NOT NULL DEFAULT 0,
    "ai_invoked" BOOLEAN NOT NULL DEFAULT false,
    "ai_skipped_reason" TEXT,
    "summary" TEXT,
    "check_errors" JSONB,
    "report" JSONB,
    "error" TEXT,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "email_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_agent_findings" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "check_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "campaign_id" TEXT,
    "run_ref_id" TEXT,
    "send_id" TEXT,
    "webhook_event_id" TEXT,
    "suggested_actions" JSONB,
    "first_detected_at" TIMESTAMP(3) NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "incident_id" TEXT,

    CONSTRAINT "email_agent_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_agent_incidents" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "technical_summary" TEXT,
    "probable_cause" TEXT,
    "confidence" DOUBLE PRECISION,
    "affected_campaign_ids" JSONB,
    "affected_run_ids" JSONB,
    "affected_send_ids" JSONB,
    "affected_event_ids" JSONB,
    "affected_count" INTEGER NOT NULL DEFAULT 1,
    "recommendation" JSONB,
    "resolution" TEXT,
    "resolution_kind" TEXT,
    "detection_count" INTEGER NOT NULL DEFAULT 1,
    "last_alert_at" TIMESTAMP(3),
    "last_alert_severity" TEXT,
    "last_alert_scope" INTEGER,
    "alert_count" INTEGER NOT NULL DEFAULT 0,
    "first_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_agent_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_agent_incident_events" (
    "id" TEXT NOT NULL,
    "incident_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_agent_incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_agent_actions" (
    "id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "policy_classification" TEXT NOT NULL,
    "policy_reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'started',
    "before_state" JSONB,
    "after_state" JSONB,
    "result" JSONB,
    "error" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'agent',
    "actor_name" TEXT,
    "ai_provider" TEXT,
    "ai_model" TEXT,
    "idempotency_key" TEXT,
    "correlation_id" TEXT NOT NULL,
    "run_id" TEXT,
    "incident_id" TEXT,
    "approval_id" TEXT,
    "campaign_id" TEXT,
    "run_ref_id" TEXT,
    "send_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "email_agent_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_agent_approvals" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "incident_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "question" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expected_effect" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "campaign_id" TEXT,
    "run_ref_id" TEXT,
    "send_id" TEXT,
    "resource_checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_by_name" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "invalidation_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_agent_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_agent_lessons" (
    "id" TEXT NOT NULL,
    "pattern_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "symptoms" JSONB NOT NULL,
    "probable_cause" TEXT NOT NULL,
    "successful_resolution" TEXT,
    "failed_approaches" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "false_positives" INTEGER NOT NULL DEFAULT 0,
    "related_check_ids" JSONB,
    "first_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_agent_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_agent_model_calls" (
    "id" TEXT NOT NULL,
    "run_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "request_id" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'investigate',
    "outcome" TEXT NOT NULL,
    "error" TEXT,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "total_tokens" INTEGER,
    "latency_ms" INTEGER,
    "input_finding_count" INTEGER,
    "recommended_tool" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_agent_model_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_agent_runs_correlation_id_key" ON "email_agent_runs"("correlation_id");

-- CreateIndex
CREATE INDEX "email_agent_runs_started_at_idx" ON "email_agent_runs"("started_at");

-- CreateIndex
CREATE INDEX "email_agent_runs_status_idx" ON "email_agent_runs"("status");

-- CreateIndex
CREATE INDEX "email_agent_runs_trigger_idx" ON "email_agent_runs"("trigger");

-- CreateIndex
CREATE INDEX "email_agent_findings_fingerprint_idx" ON "email_agent_findings"("fingerprint");

-- CreateIndex
CREATE INDEX "email_agent_findings_check_id_idx" ON "email_agent_findings"("check_id");

-- CreateIndex
CREATE INDEX "email_agent_findings_severity_idx" ON "email_agent_findings"("severity");

-- CreateIndex
CREATE INDEX "email_agent_findings_campaign_id_idx" ON "email_agent_findings"("campaign_id");

-- CreateIndex
CREATE INDEX "email_agent_findings_run_ref_id_idx" ON "email_agent_findings"("run_ref_id");

-- CreateIndex
CREATE INDEX "email_agent_findings_send_id_idx" ON "email_agent_findings"("send_id");

-- CreateIndex
CREATE INDEX "email_agent_findings_detected_at_idx" ON "email_agent_findings"("detected_at");

-- CreateIndex
CREATE INDEX "email_agent_findings_incident_id_idx" ON "email_agent_findings"("incident_id");

-- CreateIndex
CREATE INDEX "email_agent_findings_run_id_idx" ON "email_agent_findings"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_agent_incidents_reference_key" ON "email_agent_incidents"("reference");

-- CreateIndex
CREATE INDEX "email_agent_incidents_status_idx" ON "email_agent_incidents"("status");

-- CreateIndex
CREATE INDEX "email_agent_incidents_fingerprint_idx" ON "email_agent_incidents"("fingerprint");

-- CreateIndex
CREATE INDEX "email_agent_incidents_severity_idx" ON "email_agent_incidents"("severity");

-- CreateIndex
CREATE INDEX "email_agent_incidents_category_idx" ON "email_agent_incidents"("category");

-- CreateIndex
CREATE INDEX "email_agent_incidents_last_detected_at_idx" ON "email_agent_incidents"("last_detected_at");

-- CreateIndex
CREATE INDEX "email_agent_incidents_created_at_idx" ON "email_agent_incidents"("created_at");

-- CreateIndex
CREATE INDEX "email_agent_incidents_status_severity_idx" ON "email_agent_incidents"("status", "severity");

-- CreateIndex
CREATE INDEX "email_agent_incident_events_incident_id_created_at_idx" ON "email_agent_incident_events"("incident_id", "created_at");

-- CreateIndex
CREATE INDEX "email_agent_incident_events_kind_idx" ON "email_agent_incident_events"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "email_agent_actions_idempotency_key_key" ON "email_agent_actions"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_agent_actions_tool_name_idx" ON "email_agent_actions"("tool_name");

-- CreateIndex
CREATE INDEX "email_agent_actions_status_idx" ON "email_agent_actions"("status");

-- CreateIndex
CREATE INDEX "email_agent_actions_started_at_idx" ON "email_agent_actions"("started_at");

-- CreateIndex
CREATE INDEX "email_agent_actions_incident_id_idx" ON "email_agent_actions"("incident_id");

-- CreateIndex
CREATE INDEX "email_agent_actions_correlation_id_idx" ON "email_agent_actions"("correlation_id");

-- CreateIndex
CREATE INDEX "email_agent_actions_campaign_id_idx" ON "email_agent_actions"("campaign_id");

-- CreateIndex
CREATE INDEX "email_agent_actions_run_ref_id_idx" ON "email_agent_actions"("run_ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_agent_approvals_reference_key" ON "email_agent_approvals"("reference");

-- CreateIndex
CREATE INDEX "email_agent_approvals_status_idx" ON "email_agent_approvals"("status");

-- CreateIndex
CREATE INDEX "email_agent_approvals_expires_at_idx" ON "email_agent_approvals"("expires_at");

-- CreateIndex
CREATE INDEX "email_agent_approvals_incident_id_idx" ON "email_agent_approvals"("incident_id");

-- CreateIndex
CREATE INDEX "email_agent_approvals_created_at_idx" ON "email_agent_approvals"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_agent_lessons_pattern_key_key" ON "email_agent_lessons"("pattern_key");

-- CreateIndex
CREATE INDEX "email_agent_lessons_last_observed_at_idx" ON "email_agent_lessons"("last_observed_at");

-- CreateIndex
CREATE INDEX "email_agent_lessons_confidence_idx" ON "email_agent_lessons"("confidence");

-- CreateIndex
CREATE INDEX "email_agent_model_calls_created_at_idx" ON "email_agent_model_calls"("created_at");

-- CreateIndex
CREATE INDEX "email_agent_model_calls_provider_idx" ON "email_agent_model_calls"("provider");

-- CreateIndex
CREATE INDEX "email_agent_model_calls_outcome_idx" ON "email_agent_model_calls"("outcome");

-- CreateIndex
CREATE INDEX "email_agent_model_calls_correlation_id_idx" ON "email_agent_model_calls"("correlation_id");

-- AddForeignKey
ALTER TABLE "email_agent_findings" ADD CONSTRAINT "email_agent_findings_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "email_agent_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_agent_findings" ADD CONSTRAINT "email_agent_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "email_agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_agent_incident_events" ADD CONSTRAINT "email_agent_incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "email_agent_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_agent_actions" ADD CONSTRAINT "email_agent_actions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "email_agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_agent_actions" ADD CONSTRAINT "email_agent_actions_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "email_agent_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_agent_actions" ADD CONSTRAINT "email_agent_actions_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "email_agent_approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_agent_approvals" ADD CONSTRAINT "email_agent_approvals_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "email_agent_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_agent_model_calls" ADD CONSTRAINT "email_agent_model_calls_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "email_agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

