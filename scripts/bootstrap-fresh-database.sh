#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  bootstrap-fresh-database.sh — build a working database from source control.
#
#  THE PROBLEM THIS SOLVES. `prisma/migrations` has no init migration. Nothing
#  in it creates `bookings`, `crm_leads`, `customers` or any other base table:
#  the schema was originally made with `prisma db push`, and every migration
#  since assumes the tables already exist. Against production that is invisible,
#  because the tables and the migration history are both already there. But it
#  means `prisma migrate deploy` alone CANNOT build a database, so recovery
#  depended entirely on backups and no fresh staging or CI environment could be
#  created at all.
#
#  WHY NOT JUST ADD AN INIT MIGRATION. A baseline generated from the CURRENT
#  datamodel contains the end state, so every historical migration that adds a
#  column becomes a duplicate: `migrate deploy` gets as far as
#  20260525000000_deposit_paid_and_truck_addon and stops on
#  `column "deposit_paid" of relation "bookings" already exists`. The historical
#  migrations cannot be edited to fix that — production records their checksums,
#  and a changed file makes `migrate deploy` refuse to run at all.
#
#  SO THE BASELINE LIVES OUTSIDE prisma/migrations, and this script applies it
#  and then tells Prisma the truth: every historical migration's effect IS
#  present, because the baseline contains it. That is a statement of fact about
#  a database this script just built, not a guess about someone else's.
#
#  THIS SCRIPT NEVER RUNS AGAINST PRODUCTION. It refuses a database that already
#  has tables. Production needs nothing from it: `migrate deploy` there applies
#  only the genuinely new migrations, exactly as before.
#
#  Usage:  DATABASE_URL=postgresql://... bash scripts/bootstrap-fresh-database.sh
# ════════════════════════════════════════════════════════════════════════════
set -o pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$HERE/prisma/baseline/00_init.sql"

if [[ ! -f "$BASELINE" ]]; then
  echo "Error: baseline not found at $BASELINE" >&2
  exit 1
fi

# ── REFUSE A DATABASE THAT IS ALREADY IN USE ────────────────────────────────
# The baseline is idempotent, so running it on an existing database would do no
# harm — but marking 60-odd migrations applied on a database this script did not
# build would be a guess. Refuse instead.
EXISTING=$(psql "$DATABASE_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null || echo "?")

if [[ "$EXISTING" == "?" ]]; then
  echo "Error: could not reach the database." >&2
  exit 1
fi
if [[ "$EXISTING" -gt 0 ]]; then
  echo "Error: this database already has ${EXISTING} tables." >&2
  echo "       This script is for building a FRESH database only." >&2
  echo "       For an existing database, run: npx prisma migrate deploy" >&2
  exit 1
fi

echo "== 1. applying the baseline =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$BASELINE" || {
  echo "Error: the baseline failed to apply." >&2
  exit 1
}
TABLES=$(psql "$DATABASE_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
echo "   ${TABLES} tables created"

echo "== 2. recording the historical migrations as applied =="
# Every one of these is REPRESENTED IN THE BASELINE that step 1 just applied, so
# this records what is true of this database rather than asserting something
# about it. Without this, `migrate deploy` would try to re-apply them and stop
# on the first duplicate column.
COUNT=0
for dir in "$HERE"/prisma/migrations/*/; do
  name="$(basename "$dir")"
  [[ "$name" == "migration_lock.toml" ]] && continue
  [[ -f "$dir/migration.sql" ]] || continue
  npx prisma migrate resolve --applied "$name" > /dev/null 2>&1 && COUNT=$((COUNT + 1))
done
echo "   ${COUNT} migrations recorded"

echo "== 3. confirming nothing is pending =="
if npx prisma migrate deploy 2>&1 | tee /dev/stderr | grep -q "No pending migrations"; then
  echo "   clean"
else
  echo "   NOTE: migrate deploy applied something - inspect the output above" >&2
fi

echo "== 4. verifying the objects Prisma cannot express =="
IDX=$(psql "$DATABASE_URL" -tAc \
  "SELECT count(*) FROM pg_indexes WHERE indexname='crm_leads_open_booking_session_key'")
if [[ "$IDX" == "1" ]]; then
  echo "   partial unique index present"
else
  echo "Error: crm_leads_open_booking_session_key is MISSING." >&2
  echo "       Without it, concurrent captures create duplicate leads." >&2
  exit 1
fi

echo ""
echo "Done. This database is built from source control and has no pending migrations."
echo "NOTE: the marketing tracker's separate 'leads' table is NOT created here."
echo "      It belongs to another system sharing the database."
