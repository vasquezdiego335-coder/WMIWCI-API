-- ════════════════════════════════════════════════════════════════════════════
--  ADMIN DEPOSIT LINKS (owner spec 2026-08-15)
--  ------------------------------------------------------------------------
--  Adds ONE new table plus three audit-action values. Nothing existing is
--  altered, renamed or back-filled:
--    · no column is added to bookings, payments, customers or crm_leads
--    · no existing index, constraint or default is touched
--    · every historical row is already correct the instant this runs
--
--  ENUM VALUES ARE ADDED IN A SEPARATE STATEMENT GROUP AT THE TOP. Postgres
--  will not let ADD VALUE share a transaction with a statement that USES the
--  new value; nothing here uses them, so this is safe — and it matches the
--  pattern already used by 20260713000000_admin_os_audit_actions.
--
--  NOT YET APPLIED. Running this against production Neon is the owner's call:
--    npx prisma migrate deploy        (applies every pending migration)
--    npx prisma generate              (regenerates the client)
--
--  REVERSAL (fully reversible — the table is new and nothing references it):
--    DROP TABLE "deposit_requests";
--    DROP TYPE "DepositNotifyStatus";
--    DROP TYPE "DepositRequestStatus";
--    -- Postgres cannot drop a single enum VALUE; the three AuditAction values
--    -- are inert if unused, so they are left in place on a rollback.
-- ════════════════════════════════════════════════════════════════════════════

-- AlterEnum (additive; existing audit rows are unaffected)
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEPOSIT_LINK_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEPOSIT_LINK_CANCELED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEPOSIT_LINK_PAID';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DepositRequestStatus" AS ENUM ('ACTIVE', 'PAID', 'EXPIRED', 'CANCELED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DepositNotifyStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SENDING', 'SENT', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "deposit_requests" (
    "id" TEXT NOT NULL,
    "public_token" TEXT NOT NULL,
    "booking_id" TEXT,
    "lead_id" TEXT,
    "customer_name" TEXT,
    "customer_email" TEXT,
    "customer_phone" TEXT,
    "quote_total_cents" INTEGER,
    "balance_before_cents" INTEGER,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "service_summary" TEXT,
    "move_date" TIMESTAMP(3),
    "status" "DepositRequestStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3),
    "stripe_checkout_session_id" TEXT,
    "stripe_checkout_url" TEXT,
    "checkout_session_expires_at" TIMESTAMP(3),
    "checkout_attempts" INTEGER NOT NULL DEFAULT 0,
    "stripe_payment_intent_id" TEXT,
    "stripe_event_id" TEXT,
    "amount_paid_cents" INTEGER,
    "paid_at" TIMESTAMP(3),
    "payment_id" TEXT,
    "livemode" BOOLEAN,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "discord_status" "DepositNotifyStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "discord_notified_at" TIMESTAMP(3),
    "discord_retry_count" INTEGER NOT NULL DEFAULT 0,
    "discord_claimed_at" TIMESTAMP(3),
    "discord_message_id" TEXT,
    "discord_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The three UNIQUE indexes are the database half of the money guards:
--   public_token                 — one link per token, no collision
--   stripe_checkout_session_id   — one deposit per Checkout Session
--   stripe_payment_intent_id     — a replayed webhook cannot credit twice
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_public_token_key" ON "deposit_requests" ("public_token");
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_stripe_checkout_session_id_key" ON "deposit_requests" ("stripe_checkout_session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_stripe_payment_intent_id_key" ON "deposit_requests" ("stripe_payment_intent_id");
CREATE INDEX IF NOT EXISTS "deposit_requests_booking_id_idx" ON "deposit_requests" ("booking_id");
CREATE INDEX IF NOT EXISTS "deposit_requests_status_idx" ON "deposit_requests" ("status");
CREATE INDEX IF NOT EXISTS "deposit_requests_created_at_idx" ON "deposit_requests" ("created_at");
CREATE INDEX IF NOT EXISTS "deposit_requests_discord_status_idx" ON "deposit_requests" ("discord_status");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "deposit_requests"
    ADD CONSTRAINT "deposit_requests_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
