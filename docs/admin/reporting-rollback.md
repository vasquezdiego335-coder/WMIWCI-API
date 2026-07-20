# Reporting rollback

Reporting is **read-only over existing financial records**. Disabling it destroys
nothing.

## Level 1 — hide the entry point (seconds)

Set the Reports sidebar item back to `soon: true` in `Sidebar.tsx`. Pages and
routes remain reachable by URL but nobody navigates there.

## Level 2 — remove the UI (one deploy)

Delete `app/(admin)/admin/(dashboard)/reports/`. The API routes still serve JSON
for any integration.

## Level 3 — remove the API (one deploy)

Delete `app/api/admin/reports/`. All reporting stops. **No financial record is
affected** — reporting never writes to money tables. The only writes it performs
are `ReportExport` audit rows and `REPORT_EXPORTED` audit entries.

## Level 4 — application rollback

Redeploy the previous build. Every Stage 3 table is new and every Booking column
is nullable, so the prior code reads the database unchanged.

## What NOT to do

**Do not reverse the migrations.** They are additive, and dropping
`marketing_campaigns` / `marketing_spend` destroys campaign cost history that
cannot be reconstructed from anywhere else. There is deliberately no
down-migration. If a table must be removed, export it first.
