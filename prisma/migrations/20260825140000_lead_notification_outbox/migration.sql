-- ═══════════════════════════════════════════════════════════════════════════
--  LEAD NOTIFICATION OUTBOX  (V3)
--
--  WHY
--  ---
--  The owner's lead notice was one HTTPS POST with a 5s timeout — no record,
--  no retry, no deduplication. A Discord 500, a timeout, or a process restart
--  between "lead saved" and "owner told" lost the notification permanently,
--  and nothing anywhere knew. A lead the business paid to acquire simply never
--  reached the person who could call it.
--
--  This table is the durable record of an owner notification that ought to
--  exist. Work still moves on the EXISTING BullMQ `discord` queue; this table
--  owns the truth about whether the owner was actually told.
--
--  IDENTITY IS DETERMINISTIC. dedupe_key is derived from the lead and the
--  lifecycle transition and is UNIQUE, so the same transition enqueued twice
--  produces exactly one owner message. It doubles as the BullMQ jobId.
--
--  ADDITIVE: a NEW table only. No existing table is altered, and in particular
--  neither crm_leads nor the marketing tracker's separate `leads` table is
--  touched by this migration.
--
--  Rollback: drop the table. Nothing else depends on it; the previous code
--  path does not read it.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "lead_notifications" (
    "id"              TEXT NOT NULL,
    "lead_id"         TEXT NOT NULL,
    "event_type"      TEXT NOT NULL,
    "dedupe_key"      TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "claimed_at"      TIMESTAMP(3),
    "sent_at"         TIMESTAMP(3),
    "last_error"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lead_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "lead_notifications_dedupe_key_key"
    ON "lead_notifications" ("dedupe_key");

CREATE INDEX IF NOT EXISTS "lead_notifications_status_next_attempt_at_idx"
    ON "lead_notifications" ("status", "next_attempt_at");

CREATE INDEX IF NOT EXISTS "lead_notifications_lead_id_idx"
    ON "lead_notifications" ("lead_id");
