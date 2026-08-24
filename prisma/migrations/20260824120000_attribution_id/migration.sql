-- ═══════════════════════════════════════════════════════════════════════════
--  QR ATTRIBUTION ID  —  on the booking AND on the lead
--
--  WHY
--  ---
--  All 2,500 door hangers in the Essex County 2026 run carry ONE permanent
--  printed code (/q/dh). That is the right call for print — one artwork, one
--  proof, no chance of the wrong stack going to the wrong town — but it means
--  `source` can say "a door hanger" and can never say "which scan".
--
--  The marketing tracker mints an anonymous visitor id on the /q/<code>
--  redirect and passes it through the landing page, the quote form and the
--  booking form as ?aid=. Storing it here is what lets booked revenue be
--  attributed back to a specific scan, and therefore lets scan-to-booking
--  conversion be measured per city — the single question the whole tracking
--  system was built to answer, and the one it cannot answer today.
--
--  Before this, every conversion reached the tracker with attribution_id NULL,
--  scan_id NULL and campaign_key 'unattributed', and the owner's Discord
--  revenue card read "Attributed scan: no" permanently. The tracker was not
--  guessing — it refuses to credit revenue it cannot prove — so the answer was
--  honestly wrong rather than confidently wrong. It still needs fixing.
--
--  WHAT THE VALUE IS
--  -----------------
--  os.urandom(16).hex() — 32 hex characters, opaque and random. It carries no
--  personal data and identifies nobody on its own. The application layer
--  shape-checks it (see cleanAttributionId in src/lib/leads.ts), so junk from a
--  mangled shared link is dropped rather than stored in a column that later
--  gets JOINed on.
--
--  TABLE NAMES — CHECKED, NOT ASSUMED
--  ----------------------------------
--  `Booking` maps to "bookings" and `Lead` maps to "crm_leads". Production also
--  carries a separate, empty, legacy "leads" table; two migrations in a recent
--  release targeted it by mistake, would have applied cleanly, reported
--  success, and left the real table without the columns. Both names below match
--  the @@map in prisma/schema.prisma and are enforced by
--  src/lib/__tests__/migration-table-names.test.ts.
--
--  SAFETY
--  ------
--  Additive, nullable, and IF NOT EXISTS throughout. No backfill, no data is
--  read or rewritten, no existing query changes meaning, and every existing row
--  stays valid — a booking that did not come from a scan simply has no id.
--  Re-running it is a no-op.
--
--  NOT AUTO-APPLIED ON THIS PROJECT. Run it against the production branch
--  BEFORE the first hangers go out, or bookings keep arriving unattributed and
--  the print run cannot be measured retrospectively.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Bookings: the hop where a scan becomes revenue ────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "attribution_id" TEXT;

CREATE INDEX IF NOT EXISTS "bookings_attribution_id_idx"
  ON "bookings" ("attribution_id");

-- ── Leads: the majority path, because the landing CTA points at the quote
--    form and most scans become a lead before they ever become a booking ──
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "attribution_id" TEXT;

CREATE INDEX IF NOT EXISTS "crm_leads_attribution_id_idx"
  ON "crm_leads" ("attribution_id");
