-- ============================================================================
-- EMAIL LIFECYCLE FOUNDATION (2026-07-20)
--
-- Additive + idempotent. Creates the three tables the email system needs before
-- it can safely send promotional mail:
--   email_suppressions — the ONE global do-not-send list (unsubscribe, bounce,
--                        complaint, admin block), keyed on the address so it
--                        also covers Leads and Leadtracking/SendGrid contacts.
--   email_sends        — one row per attempted send, CLAIMED before the provider
--                        call. idempotency_key is the exactly-once guarantee.
--   email_events       — provider + first-party events. provider_event_id is
--                        unique so a duplicate webhook delivery is a no-op.
--
-- Nothing existing reads or writes these tables, so this is safe to apply ahead
-- of the application code. Safe to re-run.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "SuppressionReason" AS ENUM (
    'UNSUBSCRIBED',
    'HARD_BOUNCE',
    'SPAM_COMPLAINT',
    'INVALID_ADDRESS',
    'ADMIN_BLOCK',
    'PROVIDER_REJECTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "id"         TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "reason"     "SuppressionReason" NOT NULL,
  "scope"      TEXT NOT NULL DEFAULT 'all',
  "source"     TEXT,
  "detail"     TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_email_key"      ON "email_suppressions"("email");
CREATE INDEX        IF NOT EXISTS "email_suppressions_reason_idx"     ON "email_suppressions"("reason");
CREATE INDEX        IF NOT EXISTS "email_suppressions_created_at_idx" ON "email_suppressions"("created_at");

CREATE TABLE IF NOT EXISTS "email_sends" (
  "id"              TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "email"           TEXT NOT NULL,
  "template"        TEXT NOT NULL,
  "email_class"     TEXT NOT NULL,
  "journey"         TEXT,
  "booking_id"      TEXT,
  "lead_id"         TEXT,
  "campaign"        TEXT,
  "status"          TEXT NOT NULL DEFAULT 'claimed',
  "blocked_reason"  TEXT,
  "provider_id"     TEXT,
  "error"           TEXT,
  "sent_at"         TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_sends_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_sends_idempotency_key_key" ON "email_sends"("idempotency_key");
CREATE INDEX        IF NOT EXISTS "email_sends_email_idx"           ON "email_sends"("email");
CREATE INDEX        IF NOT EXISTS "email_sends_status_idx"          ON "email_sends"("status");
CREATE INDEX        IF NOT EXISTS "email_sends_journey_idx"         ON "email_sends"("journey");
CREATE INDEX        IF NOT EXISTS "email_sends_booking_id_idx"      ON "email_sends"("booking_id");
CREATE INDEX        IF NOT EXISTS "email_sends_lead_id_idx"         ON "email_sends"("lead_id");
CREATE INDEX        IF NOT EXISTS "email_sends_created_at_idx"      ON "email_sends"("created_at");

CREATE TABLE IF NOT EXISTS "email_events" (
  "id"                TEXT NOT NULL,
  "provider_event_id" TEXT NOT NULL,
  "email_send_id"     TEXT,
  "email"             TEXT NOT NULL,
  "type"              TEXT NOT NULL,
  "detail"            TEXT,
  "occurred_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_events_provider_event_id_key" ON "email_events"("provider_event_id");
CREATE INDEX        IF NOT EXISTS "email_events_email_idx"             ON "email_events"("email");
CREATE INDEX        IF NOT EXISTS "email_events_type_idx"              ON "email_events"("type");
CREATE INDEX        IF NOT EXISTS "email_events_email_send_id_idx"     ON "email_events"("email_send_id");
CREATE INDEX        IF NOT EXISTS "email_events_occurred_at_idx"       ON "email_events"("occurred_at");

DO $$ BEGIN
  ALTER TABLE "email_events"
    ADD CONSTRAINT "email_events_email_send_id_fkey"
    FOREIGN KEY ("email_send_id") REFERENCES "email_sends"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: every customer who already texted STOP is a promotional opt-out.
-- Idempotent (ON CONFLICT DO NOTHING) and safe to re-run.
INSERT INTO "email_suppressions" ("id", "email", "reason", "scope", "source", "detail", "created_at", "updated_at")
SELECT
  'sup_stop_' || c."id",
  LOWER(TRIM(c."email")),
  'UNSUBSCRIBED'::"SuppressionReason",
  'promotional',
  'sms-stop',
  'backfilled from customers.marketing_opt_out',
  NOW(),
  NOW()
FROM "customers" c
WHERE c."marketing_opt_out" = TRUE
  AND c."email" IS NOT NULL
  AND TRIM(c."email") <> ''
ON CONFLICT ("email") DO NOTHING;
