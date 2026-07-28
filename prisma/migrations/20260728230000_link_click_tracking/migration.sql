-- ═══════════════════════════════════════════════════════════════════════
--  LINK CLICK TRACKING (owner spec 2026-07-28)
--  Records an arrival from a cloaked short link (/m, /fb, /ig, /tt, /qr) so
--  "which channel sends people" is answerable in the admin and in Discord.
--
--  Additive only: one new table, no changes to any existing table, so this
--  cannot affect bookings, leads, payments or email. Safe to apply while the
--  app is running.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE "link_clicks" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "medium" TEXT,
    "campaign" TEXT,
    "landing_path" TEXT,
    "referrer" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_clicks_pkey" PRIMARY KEY ("id")
);

-- Date-range scans for the admin page and the daily digest.
CREATE INDEX "link_clicks_created_at_idx" ON "link_clicks"("created_at");

-- "Group by source over the last N days" — the main query.
CREATE INDEX "link_clicks_source_created_at_idx" ON "link_clicks"("source", "created_at");

-- Funnel join against leads.utm_campaign.
CREATE INDEX "link_clicks_campaign_created_at_idx" ON "link_clicks"("campaign", "created_at");
