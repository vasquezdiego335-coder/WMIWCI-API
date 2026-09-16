-- ═══════════════════════════════════════════════════════════════════════════
--  EMAIL CONSENT EVIDENCE + SCENARIO ENROLLMENT  (email consent release 2026-09-16)
--
--  WHY
--  ---
--  Consent was a bare tri-state boolean on crm_leads and customers, overwritten
--  in place, with no history, a browser-supplied source and version, and no way
--  to prove what a person was shown or when they withdrew. The form opt-out box
--  and the notice basis need a record that cannot be edited after the fact.
--
--  WHAT THIS ADDS (all ADDITIVE; no existing row is read, written or backfilled)
--  ------------------------------------------------------------------------------
--   1. email_consent_events   — append-only evidence. kind is TEXT + a CHECK
--      constraint. UNIQUE (request_id, kind) so a retried request records once.
--      NO foreign keys: an FK with ON DELETE SET NULL is an UPDATE the trigger
--      below refuses (lead deletion would break) and CASCADE would delete the
--      evidence. Kept >= 3 years after the last send under the basis; never
--      purged.
--   2. A trigger that REFUSES every UPDATE and DELETE on email_consent_events,
--      except the redaction performed by redact_email_consent(email) for an
--      erasure request (personal data replaced with a SHA-256 hash; kind,
--      surface, notice version, request id and time are kept).
--      TRUNCATE is deliberately NOT blocked: it is a DBA action on a disposable
--      database, never an application code path.
--   3. email_marketing_status — the per-person summary, upserted by the
--      application in the same transaction as each event, forward-only.
--   4. sequence_enrollments   — UNIQUE (email_normalized, sequence_kind,
--      window_start): one scenario sequence per person per 30-day window, even
--      under concurrent submissions.
--   5. Nullable columns: crm_leads.basis_event_id, bookings.basis_event_id,
--      email_sends.marketing_basis, email_sends.basis_event_id. No defaults, no
--      data updates, so every existing lead and booking has NO notice basis.
--
--  TABLE NAMES — CHECKED, NOT ASSUMED
--  ----------------------------------
--  Lead is @@map("crm_leads") (NOT the tracker's legacy "leads" table),
--  Booking is @@map("bookings"), EmailSend is @@map("email_sends"). The three new
--  models map to the three new table names used below.
--
--  CI EXECUTES THIS FILE. 20260916120000 sorts after the last migration
--  (20260915120200_lifecycle_enqueue_retries) and is NOT listed in
--  prisma/baseline/REPRESENTED_MIGRATIONS.txt, so
--  scripts/bootstrap-fresh-database.sh runs it through `prisma migrate deploy`.
--
--  RE-RUNNABLE. IF NOT EXISTS on every table, column and index; the CHECK
--  constraint is added only when missing; functions are CREATE OR REPLACE and
--  the trigger is dropped and recreated. Indexes are built non-concurrently in
--  the same transaction as their tables, so IF NOT EXISTS cannot mask an
--  INVALID index.
--
--  REQUIRES PostgreSQL 11+ (built-in sha256()). CI runs postgres:16.
--
--  ROLLBACK (roll the application code back FIRST; nothing else reads these):
--    DROP TRIGGER IF EXISTS "email_consent_events_append_only" ON "email_consent_events";
--    DROP FUNCTION IF EXISTS "redact_email_consent"(TEXT);
--    DROP FUNCTION IF EXISTS "email_consent_events_refuse_change"();
--    DROP TABLE IF EXISTS "sequence_enrollments";
--    DROP TABLE IF EXISTS "email_marketing_status";
--    DROP TABLE IF EXISTS "email_consent_events";
--    ALTER TABLE "email_sends" DROP COLUMN IF EXISTS "basis_event_id";
--    ALTER TABLE "email_sends" DROP COLUMN IF EXISTS "marketing_basis";
--    ALTER TABLE "bookings" DROP COLUMN IF EXISTS "basis_event_id";
--    ALTER TABLE "crm_leads" DROP COLUMN IF EXISTS "basis_event_id";
--  Dropping email_consent_events DESTROYS consent evidence. Export it first
--  (COPY "email_consent_events" TO …) unless the table is known to be empty.
-- ═══════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "basis_event_id" TEXT;

-- AlterTable
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "basis_event_id" TEXT;

-- AlterTable
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "basis_event_id" TEXT;
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "marketing_basis" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_consent_events" (
    "id" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "lead_id" TEXT,
    "customer_id" TEXT,
    "booking_id" TEXT,
    "kind" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "notice_version" TEXT,
    "notice_copy_sha256" TEXT,
    "locale" TEXT,
    "region_signal" TEXT,
    "trigger" TEXT,
    "email_user_typed" BOOLEAN,
    "opt_out_box" BOOLEAN,
    "turnstile_ok" BOOLEAN,
    "withheld_reason" TEXT,
    "page_url" TEXT,
    "ip_hmac" TEXT,
    "ua_hash" TEXT,
    "request_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_consent_events_pkey" PRIMARY KEY ("id")
);

-- The kind vocabulary. Kept in step with CONSENT_EVENT_KINDS in
-- src/lib/consent/consent-events.ts (a test compares the two).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_consent_events_kind_check'
  ) THEN
    ALTER TABLE "email_consent_events" ADD CONSTRAINT "email_consent_events_kind_check" CHECK ("kind" IN (
      'notice_accepted',
      'express_opt_in',
      'opted_out_at_capture',
      'declined_at_capture',
      'unsubscribed',
      'resubscribed',
      'basis_withheld'
    ));
  END IF;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_marketing_status" (
    "email_normalized" TEXT NOT NULL,
    "express_opt_in_at" TIMESTAMPTZ(3),
    "express_event_id" TEXT,
    "opted_out_at" TIMESTAMPTZ(3),
    "declined_at" TIMESTAMPTZ(3),
    "last_notice_at" TIMESTAMPTZ(3),
    "last_notice_event_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_marketing_status_pkey" PRIMARY KEY ("email_normalized")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sequence_enrollments" (
    "id" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "sequence_kind" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "basis_event_id" TEXT,
    "window_start" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stop_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_consent_events_email_normalized_occurred_at_idx" ON "email_consent_events"("email_normalized", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_consent_events_ip_hmac_occurred_at_idx" ON "email_consent_events"("ip_hmac", "occurred_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_consent_events_kind_occurred_at_idx" ON "email_consent_events"("kind", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_consent_events_request_id_kind_key" ON "email_consent_events"("request_id", "kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sequence_enrollments_email_normalized_status_idx" ON "sequence_enrollments"("email_normalized", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sequence_enrollments_subject_type_subject_id_idx" ON "sequence_enrollments"("subject_type", "subject_id");

-- CreateIndex (the name is Prisma's, truncated to PostgreSQL's 63-character limit)
CREATE UNIQUE INDEX IF NOT EXISTS "sequence_enrollments_email_normalized_sequence_kind_window__key" ON "sequence_enrollments"("email_normalized", "sequence_kind", "window_start");

-- ── APPEND-ONLY ENFORCEMENT ─────────────────────────────────────────────────
--  Every UPDATE and DELETE is refused, with ONE exception: an UPDATE made while
--  redact_email_consent() has set the transaction-local flag, which may only
--  replace the personal fields and must leave the evidence fields untouched.
--  The flag is a guard against application bugs, not against a database owner.
CREATE OR REPLACE FUNCTION "email_consent_events_refuse_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('email_consent.redacting', true) = 'on'
     AND NEW."id" = OLD."id"
     AND NEW."kind" = OLD."kind"
     AND NEW."surface" = OLD."surface"
     AND NEW."request_id" = OLD."request_id"
     AND NEW."occurred_at" = OLD."occurred_at"
     AND NEW."notice_version" IS NOT DISTINCT FROM OLD."notice_version"
     AND NEW."notice_copy_sha256" IS NOT DISTINCT FROM OLD."notice_copy_sha256"
     AND NEW."withheld_reason" IS NOT DISTINCT FROM OLD."withheld_reason"
     AND NEW."locale" IS NOT DISTINCT FROM OLD."locale"
     AND NEW."region_signal" IS NOT DISTINCT FROM OLD."region_signal"
     AND NEW."trigger" IS NOT DISTINCT FROM OLD."trigger"
     AND NEW."email_user_typed" IS NOT DISTINCT FROM OLD."email_user_typed"
     AND NEW."opt_out_box" IS NOT DISTINCT FROM OLD."opt_out_box"
     AND NEW."turnstile_ok" IS NOT DISTINCT FROM OLD."turnstile_ok"
     AND NEW."lead_id" IS NULL
     AND NEW."customer_id" IS NULL
     AND NEW."booking_id" IS NULL
     AND NEW."page_url" IS NULL
     AND NEW."ip_hmac" IS NULL
     AND NEW."ua_hash" IS NULL
     AND NEW."email_normalized" = 'redacted:sha256:' || encode(sha256(convert_to(OLD."email_normalized", 'UTF8')), 'hex')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'email_consent_events is append-only: % refused (erasure requests use redact_email_consent(email))', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS "email_consent_events_append_only" ON "email_consent_events";
CREATE TRIGGER "email_consent_events_append_only"
  BEFORE UPDATE OR DELETE ON "email_consent_events"
  FOR EACH ROW EXECUTE FUNCTION "email_consent_events_refuse_change"();

-- ── ERASURE ─────────────────────────────────────────────────────────────────
--  redact_email_consent('person@example.com') → number of events redacted.
--  Events: the address becomes 'redacted:sha256:<hex of the normalized address>'
--  and lead/customer/booking ids, page URL, IP HMAC and UA hash are cleared.
--  What was shown, what happened and when is kept, without identifying anyone.
--  Status: the per-person row is re-keyed to the same hash. Enrollments for the
--  address (operational state, not evidence) are deleted.
CREATE OR REPLACE FUNCTION "redact_email_consent"(p_email TEXT) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_email TEXT := lower(btrim(coalesce(p_email, '')));
  v_hash  TEXT;
  v_count INTEGER;
BEGIN
  IF v_email = '' OR position('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'redact_email_consent: an email address is required';
  END IF;
  v_hash := 'redacted:sha256:' || encode(sha256(convert_to(v_email, 'UTF8')), 'hex');

  PERFORM set_config('email_consent.redacting', 'on', true);
  UPDATE "email_consent_events"
     SET "email_normalized" = v_hash,
         "lead_id" = NULL,
         "customer_id" = NULL,
         "booking_id" = NULL,
         "page_url" = NULL,
         "ip_hmac" = NULL,
         "ua_hash" = NULL
   WHERE "email_normalized" = v_email;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('email_consent.redacting', 'off', true);

  IF EXISTS (SELECT 1 FROM "email_marketing_status" WHERE "email_normalized" = v_email) THEN
    DELETE FROM "email_marketing_status" WHERE "email_normalized" = v_hash;
    UPDATE "email_marketing_status"
       SET "email_normalized" = v_hash,
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "email_normalized" = v_email;
  END IF;

  DELETE FROM "sequence_enrollments" WHERE "email_normalized" = v_email;

  RETURN v_count;
END;
$$;
