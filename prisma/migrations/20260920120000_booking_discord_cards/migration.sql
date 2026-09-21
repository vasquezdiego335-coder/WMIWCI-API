-- ═══════════════════════════════════════════════════════════════════════════
--  ONE LIVING DISCORD CARD PER (BOOKING, AUDIENCE)  (Discord restructure 2026-09-20)
--
--  WHY
--  ---
--  A booking produced a new Discord message for every event. Each audience
--  (crew in #job-data, owner in #bookings) now has ONE message that is edited as
--  the booking moves PENDING_APPROVAL -> CONFIRMED -> IN_PROGRESS -> COMPLETED.
--  This table records which message that is.
--
--  WHAT THIS ADDS (ADDITIVE ONLY; no existing table or row is read or changed)
--  ---------------------------------------------------------------------------
--   booking_discord_cards, UNIQUE (booking_id, audience). The unique constraint
--   is the exactly-once lock for creating a card: the first INSERT wins, a
--   concurrent or retried job receives a unique violation and edits instead.
--
--  NO foreign key to bookings, on purpose (same reasoning as
--  lifecycle_enqueue_retries): the bookings table and its Prisma model are not
--  touched at all, so this migration and the code that uses it may reach
--  production in EITHER order. Before the table exists the card sync logs
--  "table missing" and skips; nothing else notices.
--
--  ROLLBACK:  DROP TABLE "booking_discord_cards";
--  (Cards already posted stay in Discord; they simply stop being edited.)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "booking_discord_cards" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "message_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "last_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_discord_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "booking_discord_cards_booking_id_audience_key" ON "booking_discord_cards"("booking_id", "audience");
