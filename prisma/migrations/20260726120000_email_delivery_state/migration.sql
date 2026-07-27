-- ============================================================================
-- EMAIL DELIVERY STATE + RECIPIENT PRESERVATION (audit E-06 / E-08, 2026-07-26)
--
-- Additive and idempotent. Safe on a populated production database:
--   * three NULLABLE timestamp columns + one nullable text column
--   * two indexes created only if absent
--   * one FOREIGN KEY behaviour change (CASCADE -> RESTRICT)
--
-- WHY THE COLUMNS: `email_sends.status = 'delivered'` has always meant "the
-- provider ACCEPTED the API call". Webhooks never wrote back to this table, so
-- a message that hard-bounced still read as delivered forever, and bounce and
-- complaint RATES — the two numbers that decide whether a sending domain
-- survives — could not be computed from it. These columns record what the
-- provider said afterwards. They are independent rather than a single status
-- because the events are not mutually exclusive and arrive out of order.
--
-- WHY THE FK CHANGE: ON DELETE CASCADE meant deleting a campaign run silently
-- destroyed every recipient row belonging to it — the only record that real
-- people were emailed. RESTRICT makes that deletion fail instead. Nothing in
-- the application deletes runs today, so this cannot break a live path; it
-- closes the hole before something does.
-- ============================================================================

ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "delivered_at"    TIMESTAMP(3);
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "bounced_at"      TIMESTAMP(3);
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "complained_at"   TIMESTAMP(3);
ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "delivery_detail" TEXT;

CREATE INDEX IF NOT EXISTS "email_sends_bounced_at_idx"    ON "email_sends"("bounced_at");
CREATE INDEX IF NOT EXISTS "email_sends_complained_at_idx" ON "email_sends"("complained_at");

-- Recipient -> run: CASCADE becomes RESTRICT. Dropping and recreating the
-- constraint is the only way to change its delete behaviour in Postgres. The
-- constraint name follows Prisma's convention; the guard keeps this rerunnable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'email_campaign_recipients_run_id_fkey'
      AND table_name = 'email_campaign_recipients'
  ) THEN
    ALTER TABLE "email_campaign_recipients"
      DROP CONSTRAINT "email_campaign_recipients_run_id_fkey";
  END IF;

  ALTER TABLE "email_campaign_recipients"
    ADD CONSTRAINT "email_campaign_recipients_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "email_campaign_runs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;
