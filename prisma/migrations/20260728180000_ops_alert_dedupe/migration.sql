-- ═══════════════════════════════════════════════════════════════════════════
--  OPS ALERT DEDUPLICATION — additive migration (owner report 2026-07-28)
--
--  NON-DESTRUCTIVE: two nullable columns on email_agent_settings. No table is
--  altered beyond that, no column is dropped, no row is written.
--
--  WHY: the monitoring cron runs every ten minutes and posted every CRITICAL
--  on every run. One stuck test campaign produced fifty identical Discord
--  messages in eight hours. These two columns hold the signature of the last
--  alert and when it was sent, shared across containers, so an UNCHANGED
--  critical repeats at most once per cooldown while a CHANGED one still goes
--  out immediately.
-- ═══════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "email_agent_settings" ADD COLUMN     "ops_alert_sent_at" TIMESTAMP(3),
ADD COLUMN     "ops_alert_signature" TEXT;

