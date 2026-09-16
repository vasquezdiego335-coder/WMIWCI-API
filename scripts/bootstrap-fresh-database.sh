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
#  and then tells Prisma the truth: every migration REPRESENTED IN THE BASELINE
#  is present, because the baseline contains it. That is a statement of fact
#  about a database this script just built, not a guess about someone else's.
#
#  WHICH MIGRATIONS ARE "REPRESENTED" IS AN EXPLICIT LIST, NOT A GUESS.
#  prisma/baseline/REPRESENTED_MIGRATIONS.txt names them. Until 2026-09-15 this
#  script resolved EVERY directory in prisma/migrations as applied, with no
#  cutoff — so a migration added after the baseline was recorded as applied
#  WITHOUT ITS SQL EVER RUNNING, `prisma migrate status` still said "up to
#  date", and CI could not fail on a broken new migration. Now:
#    step 2  records ONLY the names on the list (and fails loudly if one of them
#            has no directory, or if `migrate resolve` errors);
#    step 3  runs a plain `prisma migrate deploy`, which EXECUTES every
#            migration that is NOT on the list — exactly what production does.
#  So a new migration is proven in CI before anyone runs it against Neon.
#
#  THIS SCRIPT NEVER RUNS AGAINST PRODUCTION. It refuses a database that already
#  has tables. Production needs nothing from it: `migrate deploy` there applies
#  only the genuinely new migrations, exactly as before.
#
#  Usage:  DATABASE_URL=postgresql://... bash scripts/bootstrap-fresh-database.sh
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# psql (libpq) rejects Prisma-only query parameters such as ?schema=public, so
# psql gets the URL without its query string; Prisma keeps DATABASE_URL.
PSQL_URL="${DATABASE_URL%%\?*}"
BASELINE="$HERE/prisma/baseline/00_init.sql"
REPRESENTED="$HERE/prisma/baseline/REPRESENTED_MIGRATIONS.txt"

if [[ ! -f "$BASELINE" ]]; then
  echo "Error: baseline not found at $BASELINE" >&2
  exit 1
fi
if [[ ! -f "$REPRESENTED" ]]; then
  echo "Error: represented-migration list not found at $REPRESENTED" >&2
  exit 1
fi

# Comments, blank lines and any stray CR (a Windows checkout) are stripped.
mapfile -t REPRESENTED_NAMES < <(sed -e 's/\r$//' -e 's/#.*//' -e 's/[[:space:]]*$//' "$REPRESENTED" | grep -v '^$' || true)
if [[ ${#REPRESENTED_NAMES[@]} -eq 0 ]]; then
  echo "Error: $REPRESENTED lists no migrations." >&2
  exit 1
fi

# ── REFUSE A DATABASE THAT IS ALREADY IN USE ────────────────────────────────
# The baseline is idempotent, so running it on an existing database would do no
# harm — but marking 60-odd migrations applied on a database this script did not
# build would be a guess. Refuse instead.
EXISTING=$(psql "$PSQL_URL" -tAc \
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
psql "$PSQL_URL" -v ON_ERROR_STOP=1 -q -f "$BASELINE"
TABLES=$(psql "$PSQL_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
echo "   ${TABLES} tables created"

echo "== 2. recording the migrations the baseline already contains =="
# Every name below is REPRESENTED IN THE BASELINE that step 1 just applied, so
# this records what is true of this database rather than asserting something
# about it. Without it, `migrate deploy` would try to re-apply them and stop on
# the first duplicate column.
#
# Failures are NOT swallowed. A missing directory or a failing resolve means the
# list and the repository disagree, and continuing would silently produce a
# database that does not match source control.
for name in "${REPRESENTED_NAMES[@]}"; do
  if [[ ! -f "$HERE/prisma/migrations/$name/migration.sql" ]]; then
    echo "Error: $REPRESENTED lists '$name' but prisma/migrations/$name/migration.sql does not exist." >&2
    echo "       A migration that the baseline represents must never be deleted." >&2
    exit 1
  fi
  if ! npx prisma migrate resolve --applied "$name" > /dev/null; then
    echo "Error: could not record '$name' as applied." >&2
    exit 1
  fi
done
echo "   ${#REPRESENTED_NAMES[@]} migrations recorded as already contained in the baseline"

echo "== 3. applying every migration the baseline does NOT contain =="
# These are the genuinely new ones. `migrate deploy` RUNS their SQL. Under
# `set -e` a failure here fails the build, which is the entire point: a new
# migration is proven on a database built from source control before anyone
# runs it against production.
NEW_COUNT=0
for dir in "$HERE"/prisma/migrations/*/; do
  name="$(basename "$dir")"
  [[ -f "$dir/migration.sql" ]] || continue
  listed=no
  for known in "${REPRESENTED_NAMES[@]}"; do
    if [[ "$name" == "$known" ]]; then listed=yes; break; fi
  done
  if [[ "$listed" == "no" ]]; then
    echo "   will execute: $name"
    NEW_COUNT=$((NEW_COUNT + 1))
  fi
done
if [[ "$NEW_COUNT" -eq 0 ]]; then
  echo "   (none — every migration is represented by the baseline)"
fi
npx prisma migrate deploy
echo "   ${NEW_COUNT} migration(s) executed for real"

echo "== 4. verifying the objects Prisma cannot express =="
# A partial unique index cannot be written as @@unique in schema.prisma, so
# nothing but this check proves it survived. `indisunique AND indisvalid`
# matters: an index left INVALID by a failed build still appears in pg_indexes
# but enforces nothing.
LEAD_IDX=$(psql "$PSQL_URL" -tAc \
  "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'crm_leads_open_booking_session_key' AND i.indisunique AND i.indisvalid")
if [[ "$LEAD_IDX" == "1" ]]; then
  echo "   crm_leads_open_booking_session_key present, unique and valid"
else
  echo "Error: crm_leads_open_booking_session_key is MISSING or not a valid unique index." >&2
  echo "       Without it, concurrent captures create duplicate leads." >&2
  exit 1
fi

RUN_IDX=$(psql "$PSQL_URL" -tAc \
  "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'email_campaign_runs_one_unfinished_per_campaign' AND i.indisunique AND i.indisvalid")
if [[ "$RUN_IDX" == "1" ]]; then
  echo "   email_campaign_runs_one_unfinished_per_campaign present, unique and valid"
else
  echo "Error: email_campaign_runs_one_unfinished_per_campaign is MISSING or not a valid unique index." >&2
  echo "       Without it two runs of one campaign can be unfinished at once and" >&2
  echo "       every recipient is sent twice. Step 3 was supposed to create it." >&2
  exit 1
fi

RETRY_TBL=$(psql "$PSQL_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables
   WHERE table_schema='public' AND table_name='lifecycle_enqueue_retries'")
if [[ "$RETRY_TBL" == "1" ]]; then
  echo "   lifecycle_enqueue_retries table present"
else
  echo "Error: lifecycle_enqueue_retries is MISSING. Step 3 was supposed to create it." >&2
  echo "       Without it an enqueue that fails is lost and the journey never runs." >&2
  exit 1
fi

echo ""
echo "Done. This database is built from source control and has no pending migrations."
echo "NOTE: the marketing tracker's separate 'leads' table is NOT created here."
echo "      It belongs to another system sharing the database."
