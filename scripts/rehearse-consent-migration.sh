#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  rehearse-consent-migration.sh — a PRODUCTION-LIKE rehearsal of
#  prisma/migrations/20260916120000_email_consent_enrollment.
#
#  WHAT CI ALREADY PROVED, AND WHAT IT DID NOT. bootstrap-fresh-database.sh
#  EXECUTES this migration — on an EMPTY database. Production will run it on a
#  database that already holds leads, bookings and sends, already records ~70
#  migrations, and is reached by a role that is not a superuser. "It ran on an
#  empty database" does not prove that existing rows are untouched, that nothing
#  is backfilled, that the append-only trigger holds for the table owner, that a
#  second deploy is a no-op, or that the email preflight passes afterwards. This
#  script proves each of those on a SECOND throwaway database, `ci_prodlike`.
#
#  HOW THE PRE-RELEASE DATABASE IS BUILT — AND WHY THIS WAY.
#  Production's pre-release state is "tables first made by `prisma db push`,
#  then every migration up to 20260915120200 executed over time". That history
#  cannot be replayed from source control: there is no init migration, and the
#  historical files are not re-runnable on top of a baseline (see the header of
#  bootstrap-fresh-database.sh). So "apply every migration in order with psql"
#  is not possible, and would not be how any environment was built anyway. The
#  closest reproducible state is the one the bootstrap builds, stopped one
#  migration short. So this script:
#    1. stages a temporary copy of prisma/ WITHOUT the new migration directory,
#       next to a BYTE-IDENTICAL copy of bootstrap-fresh-database.sh (the script
#       resolves its paths from its own location, so the copy builds from the
#       copy), and runs it against ci_prodlike. The bootstrap logic is reused,
#       not re-implemented: baseline, record the represented migrations, then a
#       real `migrate deploy` of the three 20260915 migrations. Rejected:
#       `migrate resolve --rolled-back` (records a claim, builds nothing).
#    2. adds the facts about production that the generated baseline cannot carry:
#       a. the CHECK constraints and one index that four email migrations
#          created by RUNNING in production. A baseline generated from the Prisma
#          datamodel cannot express a CHECK constraint, so without this the
#          preflight reports drift production does not have. Their SQL is
#          re-executed verbatim; every statement in them is guarded.
#       b. what production has from OUTSIDE this branch: the pgcrypto extension
#          (its functions share the public schema with the new ones), and the
#          objects of the four migrations applied from claude/inc19-release
#          (crm_leads.brand NOT NULL DEFAULT 'MOVING' and four more columns, the
#          Brand enum, six LeadSource values, three indexes) — which is what
#          gives the rehearsal's crm_leads production's 75 columns.
#       c. production's _prisma_migrations shape: those four migrations (with
#          the checksums production recorded) that are absent from this
#          directory, and four rolled-back attempts (two each for two migrations).
#    3. seeds production-shaped rows (every address @example.com, every street
#       address fictional), then runs the REAL `npx prisma migrate deploy` from
#       the repository's full migrations directory — the DEPLOY.md §10 command —
#       as a NON-superuser role that owns the database, like Neon's owner role.
#
#  NOT CAPTURED (a green run says nothing about these): PostgreSQL 17 on Neon
#  (CI is 16); older drift whose DDL is in no file (18 extra bookings columns,
#  other defaults, the tracker's leads/meta/scans/sources tables, the CHECKs of
#  migrations the baseline represents but this script does not replay); real
#  row contents; Neon's network, direct-vs-pooler host and sslmode; concurrent
#  traffic waiting on the ACCESS EXCLUSIVE locks (production's lock_timeout is 0).
#
#  THIS SCRIPT NEVER RUNS AGAINST PRODUCTION. It refuses neon.tech / railway /
#  upstash URLs outright (the same patterns as src/lib/__tests__/_disposable-
#  test-env.ts) and, unless REHEARSAL_ALLOW_REMOTE_HOST=1, any host that is not
#  local. It creates and drops ONLY the database ci_prodlike and the role
#  ci_prodlike_owner; the database DATABASE_URL names is only used to issue
#  those CREATE/DROP statements.
#
#  Usage:  DATABASE_URL=postgresql://ci:ci@127.0.0.1:5432/ci?schema=public \
#            bash scripts/rehearse-consent-migration.sh
#  Needs: psql, a server role allowed to CREATE ROLE and CREATE DATABASE,
#  installed node_modules (it never downloads anything), and symlink support
#  (Linux / macOS — CI). KEEP_PRODLIKE_DB=1 keeps the database after a pass; a
#  failed run always keeps it for inspection.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

MIGRATION="20260916120000_email_consent_enrollment"
TARGET_DB="ci_prodlike"
TARGET_ROLE="ci_prodlike_owner"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# `npx` must never fetch a package. Without this, a missing local binary makes
# npx install whatever is published under that name (ci.yml records it happening
# with `tsc`). With yes=false npx fails instead.
export npm_config_yes=false
# Prisma's CLI colours its output even when it is captured (its colour library
# only checks FORCE_COLOR / NO_COLOR / TERM, not whether stdout is a terminal),
# and it styles the part of a migration name after the timestamp — so a grep for
# the full name would miss it. Colours off, and stripped again below regardless.
# CHECKPOINT_DISABLE stops the CLI's version-check network call.
export NO_COLOR=1 FORCE_COLOR=0 CHECKPOINT_DISABLE=1

# ── RESULT BOOKKEEPING ──────────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()
WORK=""
MIGRATION_MS_SERVER="?"
MIGRATION_MS_WALL="?"
ERR_LINE=""
ERR_CMD=""

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  RESULTS+=("PASS  $1")
  echo "   PASS  $1"
}
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  RESULTS+=("FAIL  $1")
  echo "   FAIL  $1" >&2
  if [[ -n "${2:-}" ]]; then printf '         %s\n' "$2" >&2; fi
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then echo "::error title=Consent migration rehearsal::$1"; fi
}
# A setup step failed: nothing after it would mean anything.
abort() {
  fail "$1" "${2:-}"
  exit 1
}
expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label" "expected: $expected | actual: $actual"
  fi
}
contains() { grep -Fq -- "$2" <<<"$1"; }
section() { echo ""; echo "== $1 =="; }
strip_ansi() { sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g'; }

now_ms() {
  local n
  n="$(date +%s%N 2>/dev/null || true)"
  if [[ "$n" =~ ^[0-9]{13,}$ ]]; then echo $((n / 1000000)); else echo $(($(date +%s) * 1000)); fi
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

on_exit() {
  local code=$?
  set +e
  if [[ $code -ne 0 && $FAIL_COUNT -eq 0 ]]; then
    fail "the rehearsal stopped unexpectedly (exit $code) at line ${ERR_LINE:-?}: ${ERR_CMD:-?}"
  fi
  echo ""
  echo "════════════════════════════════════════════════════════════════════"
  echo " CONSENT MIGRATION REHEARSAL — $MIGRATION"
  echo "════════════════════════════════════════════════════════════════════"
  local r
  for r in "${RESULTS[@]}"; do echo " $r"; done
  echo "--------------------------------------------------------------------"
  echo " migration duration: ${MIGRATION_MS_SERVER} ms in the database (started_at -> finished_at),"
  echo "                     ${MIGRATION_MS_WALL} ms wall-clock for \`npx prisma migrate deploy\`"
  echo " checks: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  local verdict="PASS"
  if [[ $FAIL_COUNT -gt 0 || $code -ne 0 ]]; then verdict="FAIL"; fi
  echo " RESULT: $verdict"
  echo "════════════════════════════════════════════════════════════════════"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Production-like rehearsal of \`$MIGRATION\`: $verdict"
      echo ""
      echo "Migration took **${MIGRATION_MS_SERVER} ms** in the database (${MIGRATION_MS_WALL} ms wall-clock for \`npx prisma migrate deploy\`)."
      echo ""
      for r in "${RESULTS[@]}"; do echo "- \`${r%%  *}\` ${r#*  }"; done
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  if [[ -n "${ADMIN_PSQL_URL:-}" ]]; then
    if [[ "$verdict" == "PASS" && "${KEEP_PRODLIKE_DB:-}" != "1" ]]; then
      psql -X -q "$ADMIN_PSQL_URL" -c "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)" >/dev/null 2>&1
      psql -X -q "$ADMIN_PSQL_URL" -c "DROP ROLE IF EXISTS \"$TARGET_ROLE\"" >/dev/null 2>&1
      echo " ${TARGET_DB} and ${TARGET_ROLE} dropped."
    elif [[ "${DB_CREATED:-}" == "1" ]]; then
      echo " ${TARGET_DB} was KEPT for inspection (same server as DATABASE_URL; owner role ${TARGET_ROLE})."
    fi
  fi
  if [[ -n "$WORK" && -d "$WORK" ]]; then rm -rf "$WORK"; fi
  if [[ "$verdict" == "PASS" ]]; then exit 0; fi
  exit 1
}
trap 'ERR_LINE=$LINENO; ERR_CMD=$BASH_COMMAND' ERR
trap on_exit EXIT

# ════════════════════════════════════════════════════════════════════════════
section "0. refusing anything that is not a disposable local server"
# ════════════════════════════════════════════════════════════════════════════
if [[ -z "${DATABASE_URL:-}" ]]; then
  abort "DATABASE_URL is not set" "point it at a DISPOSABLE PostgreSQL server (CI: the verify job's service container)"
fi

# The same production host patterns as src/lib/__tests__/_disposable-test-env.ts
# (assertNoProductionCredentials), checked on the same variables plus the shadow
# URL. A production-looking value is a hard failure, never a skip — and no
# override exists for it.
PRODUCTION_HOSTS='neon\.tech|rlwy\.net|railway\.internal|railway\.app|upstash\.io'
for var in DATABASE_URL SHADOW_DATABASE_URL REDIS_URL REDIS_TEST_URL; do
  if grep -Eiq "$PRODUCTION_HOSTS" <<<"${!var:-}"; then
    abort "$var points at production-looking infrastructure (neon.tech / railway / upstash) — refusing to run"
  fi
done
if grep -Eq '^re_[A-Za-z0-9_]{8,}$' <<<"${RESEND_API_KEY:-}" && ! grep -Eiq '^re_test_|^re_(dummy|fake|placeholder)' <<<"${RESEND_API_KEY:-}"; then
  abort "RESEND_API_KEY looks like a real Resend key — refusing to run"
fi

SCHEME="${DATABASE_URL%%://*}"
if [[ "$SCHEME" != "postgresql" && "$SCHEME" != "postgres" ]]; then
  abort "DATABASE_URL is not a postgresql:// URL"
fi
REST="${DATABASE_URL#*://}"
QUERY=""
if [[ "$REST" == *\?* ]]; then
  QUERY="?${REST#*\?}"
  REST="${REST%%\?*}"
fi
AUTHORITY="${REST%%/*}"
HOSTPORT="${AUTHORITY##*@}"
if [[ "$HOSTPORT" == \[* ]]; then
  DB_HOST="${HOSTPORT%%]*}]"
else
  DB_HOST="${HOSTPORT%%:*}"
fi
ADMIN_DB="${REST#*/}"
if [[ "$REST" != */* || -z "$ADMIN_DB" ]]; then
  abort "DATABASE_URL names no database"
fi
if [[ "$ADMIN_DB" == "$TARGET_DB" ]]; then
  abort "DATABASE_URL already names $TARGET_DB — point it at the server's normal database; this script creates $TARGET_DB itself"
fi

# This script DROPS a database and creates a role, so "not production-looking"
# is not enough: the server must be local (or a single-label service-container
# name) unless the caller says otherwise, explicitly.
case "$DB_HOST" in
  127.0.0.1 | localhost | "[::1]") ;;
  *)
    if [[ "${REHEARSAL_ALLOW_REMOTE_HOST:-}" != "1" ]] && ! [[ "$DB_HOST" =~ ^[A-Za-z0-9_-]+$ ]]; then
      abort "host '$DB_HOST' is not local" "set REHEARSAL_ALLOW_REMOTE_HOST=1 only for a server you know is disposable"
    fi
    ;;
esac
pass "target server is disposable ($DB_HOST); no production-looking credential in the environment"

# psql (libpq) rejects Prisma-only query parameters such as ?schema=public, so
# psql gets URLs without the query string; Prisma keeps it — as the bootstrap does.
ADMIN_PSQL_URL="${DATABASE_URL%%\?*}"
ROLE_PASSWORD="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
OWNER_PRISMA_URL="${SCHEME}://${TARGET_ROLE}:${ROLE_PASSWORD}@${HOSTPORT}/${TARGET_DB}${QUERY}"
OWNER_PSQL_URL="${SCHEME}://${TARGET_ROLE}:${ROLE_PASSWORD}@${HOSTPORT}/${TARGET_DB}"

# Every psql session: no NOTICE noise from the guarded (IF NOT EXISTS) re-runs,
# and a fixed date/time/float rendering so a checksum can only change when data
# does. PGOPTIONS is read by libpq (psql) only; Prisma's own driver ignores it.
PSQL=(env "PGOPTIONS=-c client_min_messages=warning -c datestyle=ISO -c timezone=UTC -c extra_float_digits=3" psql -X -v ON_ERROR_STOP=1 -q -t -A)
adm() { "${PSQL[@]}" "$ADMIN_PSQL_URL" -c "$1"; }
q() { "${PSQL[@]}" "$OWNER_PSQL_URL" -c "$1"; }
q_stdin() { "${PSQL[@]}" "$OWNER_PSQL_URL" -f -; }
# Prisma / tsx against ci_prodlike ONLY, as the owner role, output de-coloured.
# pipefail makes the pipeline's status the command's status.
prisma_owner() { DATABASE_URL="$OWNER_PRISMA_URL" npx prisma "$@" 2>&1 | strip_ansi; }
preflight_owner() { DATABASE_URL="$OWNER_PRISMA_URL" npx tsx scripts/email-schema-preflight.ts 2>&1 | strip_ansi; }

command -v psql >/dev/null 2>&1 || abort "psql is not installed"
[[ -x "$HERE/node_modules/.bin/prisma" ]] || abort "node_modules/.bin/prisma is missing — run npm ci first (this script never downloads)"
[[ -x "$HERE/node_modules/.bin/tsx" ]] || abort "node_modules/.bin/tsx is missing — run npm ci first (this script never downloads)"
[[ -f "$HERE/prisma/migrations/$MIGRATION/migration.sql" ]] || abort "prisma/migrations/$MIGRATION/migration.sql does not exist"

# ════════════════════════════════════════════════════════════════════════════
section "1. a fresh ${TARGET_DB}, owned by a NON-superuser role"
# ════════════════════════════════════════════════════════════════════════════
# Production's migration role owns its tables and is not a superuser
# (rolsuper = false on Neon). A migration that silently relied on superuser
# rights would pass as the CI superuser and fail on Neon, so the rehearsal runs
# every DDL statement as an ordinary owner role instead. This one is stricter
# than Neon's: no CREATEDB, no CREATEROLE.
adm "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)" >/dev/null || abort "could not drop a leftover $TARGET_DB"
adm "DROP ROLE IF EXISTS \"$TARGET_ROLE\"" >/dev/null || abort "could not drop a leftover $TARGET_ROLE"
adm "CREATE ROLE \"$TARGET_ROLE\" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$ROLE_PASSWORD'" >/dev/null \
  || abort "could not create role $TARGET_ROLE (the DATABASE_URL role needs CREATEROLE)"
adm "CREATE DATABASE \"$TARGET_DB\" OWNER \"$TARGET_ROLE\"" >/dev/null \
  || abort "could not create database $TARGET_DB (the DATABASE_URL role needs CREATEDB)"
DB_CREATED=1
expect_eq "rehearsal role is not a superuser" "not-superuser" \
  "$(q "SELECT CASE WHEN rolsuper THEN 'superuser' ELSE 'not-superuser' END FROM pg_roles WHERE rolname = current_user")"
echo "   server: $(q "SHOW server_version")"

# ════════════════════════════════════════════════════════════════════════════
section "2. PRE-release schema: the bootstrap, from a copy of prisma/ without ${MIGRATION}"
# ════════════════════════════════════════════════════════════════════════════
WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/consent-rehearsal.XXXXXX")"
mkdir -p "$WORK/scripts" "$WORK/prisma/migrations"
cp "$HERE/scripts/bootstrap-fresh-database.sh" "$WORK/scripts/bootstrap-fresh-database.sh"
cp -R "$HERE/prisma/baseline" "$WORK/prisma/baseline"
cp "$HERE/prisma/schema.prisma" "$WORK/prisma/schema.prisma"
cp "$HERE/prisma/migrations/migration_lock.toml" "$WORK/prisma/migrations/migration_lock.toml"
STAGED=0
for dir in "$HERE"/prisma/migrations/*/; do
  name="$(basename "$dir")"
  [[ -f "$dir/migration.sql" ]] || continue
  [[ "$name" == "$MIGRATION" ]] && continue
  cp -R "$HERE/prisma/migrations/$name" "$WORK/prisma/migrations/$name"
  STAGED=$((STAGED + 1))
done
cp "$HERE/package.json" "$WORK/package.json"
# `npx prisma` inside the copy must resolve THIS repository's pinned binaries.
ln -s "$HERE/node_modules" "$WORK/node_modules"
[[ -L "$WORK/node_modules" ]] || abort "could not symlink node_modules (no symlink support here — run in CI, Linux or macOS)"
cmp -s "$HERE/scripts/bootstrap-fresh-database.sh" "$WORK/scripts/bootstrap-fresh-database.sh" \
  || abort "the staged bootstrap is not byte-identical to scripts/bootstrap-fresh-database.sh"
[[ ! -e "$WORK/prisma/migrations/$MIGRATION" ]] || abort "the staged migrations still contain $MIGRATION"
echo "   staged ${STAGED} migrations (every one except ${MIGRATION})"

if (cd "$WORK" && DATABASE_URL="$OWNER_PRISMA_URL" bash scripts/bootstrap-fresh-database.sh); then
  pass "bootstrap-fresh-database.sh built the pre-release schema as the owner role"
else
  abort "bootstrap-fresh-database.sh failed on the pre-release copy"
fi

# ── 2a. objects production has because these migrations RAN there ─────────
# The baseline represents these four migrations, so CI records them without
# executing them — and a baseline generated from the datamodel has no CHECK
# constraints. Production executed them, so it HAS:
#   email_sends_status_check, email_sends_email_class_check,
#   email_sends_email_class_status_sent_at_idx, email_suppressions_scope_check,
#   email_events_processing_status_check, followup_ledger_status_check,
#   email_journey_configs_version_positive, email_automations_status_known,
#   email_automation_versions_version_positive.
# Every statement in these files is guarded (IF NOT EXISTS / duplicate_object),
# and their UPDATEs touch no row because nothing is seeded yet. Run verbatim,
# one transaction per file, as the owner role.
REPLAY=(
  20260720010000_email_event_side_effects
  20260720020000_email_send_attempts
  20260720040000_followup_ledger_channels
  20260721230000_email_marketing_admin
)
for name in "${REPLAY[@]}"; do
  if "${PSQL[@]}" "$OWNER_PSQL_URL" -1 -f "$HERE/prisma/migrations/$name/migration.sql" >/dev/null; then
    pass "re-executed $name (production ran it; the baseline lacks its CHECK constraints)"
  else
    abort "re-executing $name failed"
  fi
done

# ── 2b. objects production has from outside this branch ────────────────────
# pgcrypto 1.3 is installed in production's database (its functions live in
# public, next to where the migration creates its two). It is a trusted
# extension, so the database owner installs it — as on Neon.
q "CREATE EXTENSION IF NOT EXISTS pgcrypto" >/dev/null \
  || abort "could not install pgcrypto as the owner role (production has it)"
pass "pgcrypto installed as the owner role (production has pgcrypto 1.3)"

# The four migrations applied to production from claude/inc19-release. Their
# files were recovered byte-for-byte in commit 11f0b52a, and the SHA-256 of each
# equals the checksum production recorded (checked again 2026-09-16). This branch
# does not contain them, so their statements are reproduced here, comments
# removed, in their original order. Every statement is guarded; the two UPDATEs
# touch no row because nothing is seeded yet. One transaction, owner role.
q_stdin >/dev/null <<'SQL' || abort "could not apply the objects of production's four other-branch migrations"
BEGIN;
-- 20260803000000_quote_lead_capture
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'DIRECT';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'ORGANIC_SEARCH';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'GOOGLE_ADS';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'TIKTOK';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'MARKETPLACE';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'QR_CODE';
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'UNKNOWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEAD_QUOTE_CONFIRMATION_RESENT';
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "contact_preference" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "best_time_to_call" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "pickup_zip" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "destination_zip" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "source_detail" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_request_confirmation_sent_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_request_confirmation_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_fingerprint" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "last_alerted_at" TIMESTAMP(3);
-- 20260804000000_quote_notification_delivery_state
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_status" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_delivered_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_failed_at" TIMESTAMP(3);
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "quote_confirmation_last_error" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_status" TEXT;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "alert_delivered_at" TIMESTAMP(3);
UPDATE "crm_leads"
   SET "quote_confirmation_status" = 'queued'
 WHERE "quote_request_confirmation_sent_at" IS NOT NULL
   AND "quote_confirmation_status" IS NULL;
UPDATE "crm_leads"
   SET "alert_status" = 'queued'
 WHERE "last_alerted_at" IS NOT NULL
   AND "alert_status" IS NULL;
CREATE INDEX IF NOT EXISTS "crm_leads_quote_confirmation_status_idx"
    ON "crm_leads" ("quote_confirmation_status");
-- 20260805120000_brand_dimension_leads
DO $$ BEGIN
  CREATE TYPE "Brand" AS ENUM ('MOVING', 'CLEANING');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "crm_leads"
  ADD COLUMN IF NOT EXISTS "brand" "Brand" NOT NULL DEFAULT 'MOVING';
CREATE INDEX IF NOT EXISTS "crm_leads_brand_status_idx" ON "crm_leads" ("brand", "status");
CREATE INDEX IF NOT EXISTS "crm_leads_brand_created_at_idx" ON "crm_leads" ("brand", "created_at");
-- 20260812120000_booking_attribution_id
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "attribution_id" TEXT;
CREATE INDEX IF NOT EXISTS "bookings_attribution_id_idx"
  ON "bookings" ("attribution_id");
COMMIT;
SQL
expect_eq "crm_leads has production's column count, and the Brand enum and six extra LeadSource values exist" "75|MOVING,CLEANING|31" \
  "$(q "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crm_leads')
         || '|' || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'Brand')
         || '|' || (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'LeadSource')")"

# ── 2c. production's migration history, not just its schema ───────────────
# Production's _prisma_migrations (75 rows, 71 names on 2026-09-16) also records
# the four other-branch migrations (absent from this directory) and four
# rolled-back attempts: two for 20260629000000 and two for 20260713000100.
# Names, timestamps, step counts and the four checksums are production's own
# (the checksums equal the SHA-256 of the files in commit 11f0b52a); the rolled-
# back attempts get placeholder checksums, which Prisma never reads.
# Measured on a disposable database (commit 11f0b52a, claude/inc19-release): with
# migrations present only in the database, `migrate deploy` still applies a new
# one and `migrate status` exits 0 once nothing is pending. The rehearsal holds
# production to that instead of assuming it.
q_stdin >/dev/null <<'SQL' || abort "could not record production's migration-history shape"
INSERT INTO "_prisma_migrations"
  ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
SELECT gen_random_uuid()::text,
       coalesce(m.checksum, encode(sha256(convert_to('placeholder:' || m.name || ':' || m.started_at::text, 'UTF8')), 'hex')),
       m.finished_at, m.name, m.logs, m.rolled_back_at, m.started_at, m.steps
  FROM (VALUES
    ('20260803000000_quote_lead_capture',                  '0871571ebc1c7a0b34f8fd12b8c6cfa59f5e21a8810fab9111b166ffc3637ca2', TIMESTAMPTZ '2026-08-04 11:59:26.918+00', TIMESTAMPTZ '2026-08-04 11:59:26.993+00', NULL::timestamptz,                        NULL::text, 1),
    ('20260804000000_quote_notification_delivery_state',   'dbf84abca5385a8102026d9cb6aa75f9c014475ebbb8031003bca8ead2816f81', TIMESTAMPTZ '2026-08-04 12:53:12.234+00', TIMESTAMPTZ '2026-08-04 12:53:12.316+00', NULL,                                     NULL,       1),
    ('20260805120000_brand_dimension_leads',               '112bef0f1f16103482e3b9956b3ada38585e5bac6eac17f962db766de23e59b8', TIMESTAMPTZ '2026-08-17 22:20:40.182+00', TIMESTAMPTZ '2026-08-17 22:20:40.472+00', NULL,                                     NULL,       1),
    ('20260812120000_booking_attribution_id',              '63ba8088c34c6771ee23e2669ac5b2d7e121ea0085968f53736ae49b44cb2fa1', TIMESTAMPTZ '2026-08-17 22:20:40.534+00', TIMESTAMPTZ '2026-08-17 22:20:40.749+00', NULL,                                     NULL,       1),
    ('20260629000000_phase2_phase3_attribution_followups', NULL::text,                                                         TIMESTAMPTZ '2026-07-11 21:44:49.093+00', NULL,                                     TIMESTAMPTZ '2026-07-11 21:57:00.852+00', 'rehearsal: failed attempt, later rolled back', 0),
    ('20260629000000_phase2_phase3_attribution_followups', NULL,                                                               TIMESTAMPTZ '2026-07-11 21:57:13.295+00', NULL,                                     TIMESTAMPTZ '2026-07-11 21:58:12.131+00', 'rehearsal: failed attempt, later rolled back', 0),
    ('20260713000100_admin_operating_system',              NULL,                                                               TIMESTAMPTZ '2026-07-13 11:57:21.003+00', NULL,                                     TIMESTAMPTZ '2026-07-13 11:59:27.990+00', 'rehearsal: failed attempt, later rolled back', 0),
    ('20260713000100_admin_operating_system',              NULL,                                                               TIMESTAMPTZ '2026-07-13 11:59:33.465+00', NULL,                                     TIMESTAMPTZ '2026-07-13 12:00:06.157+00', 'rehearsal: failed attempt, later rolled back', 0)
  ) AS m(name, checksum, started_at, finished_at, rolled_back_at, logs, steps);
SQL
expect_eq "production's history shape recorded (4 finished migrations absent from this directory, 4 rolled-back attempts)" "4|4" \
  "$(q "SELECT (SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name IN ('20260803000000_quote_lead_capture', '20260804000000_quote_notification_delivery_state', '20260805120000_brand_dimension_leads', '20260812120000_booking_attribution_id') AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
         || '|' || (SELECT count(*) FROM \"_prisma_migrations\" WHERE rolled_back_at IS NOT NULL)")"

# ── 2d. it really is the PRE-release state ──────────────────────────────────
expect_eq "${MIGRATION} is not recorded before the deploy" "0" \
  "$(q "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$MIGRATION'")"
expect_eq "no consent-release object exists before the deploy (tables|columns|functions|trigger)" "0|0|0|0" \
  "$(q "SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('email_consent_events','email_marketing_status','sequence_enrollments'))
         || '|' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('basis_event_id','marketing_basis'))
         || '|' || (SELECT count(*) FROM pg_proc WHERE proname IN ('email_consent_events_refuse_change','redact_email_consent'))
         || '|' || (SELECT count(*) FROM pg_trigger WHERE tgname = 'email_consent_events_append_only')")"

# Prisma's `migrate status` reports "databaseIsBehind" or, when the database
# ALSO holds migrations the directory lacks (production's four), "historiesDiverge"
# — both exit 1 and name the unapplied migration.
rc=0
STATUS_BEFORE="$(prisma_owner migrate status)" || rc=$?
if [[ $rc -ne 0 ]] && contains "$STATUS_BEFORE" "$MIGRATION"; then
  if contains "$STATUS_BEFORE" "are different"; then
    pass "migrate status (before) exits $rc and names ${MIGRATION} as not yet applied — as a DIVERGED history, which production prints too (4 migrations absent from this repo)"
  else
    pass "migrate status (before) exits $rc and names ${MIGRATION} as not yet applied"
  fi
else
  fail "migrate status (before) must report ${MIGRATION} as pending" "exit $rc: $(tail -n 15 <<<"$STATUS_BEFORE" | tr '\n' ' ')"
fi

# The production preflight on 2026-09-16 (before any deploy) reported exactly the
# consent-release objects as drift and nothing else. The rehearsal database must
# look the same to it, or it is not a stand-in for production.
rc=0
PREFLIGHT_BEFORE="$(preflight_owner)" || rc=$?
DRIFT_BEFORE="$(grep -E '^[[:space:]]*DRIFT ' <<<"$PREFLIGHT_BEFORE" || true)"
UNRELATED_BEFORE="$(grep -Ev 'basis_event_id|marketing_basis|email_consent_events|email_marketing_status|sequence_enrollments' <<<"$DRIFT_BEFORE" || true)"
if [[ $rc -eq 1 && -n "$DRIFT_BEFORE" && -z "$UNRELATED_BEFORE" ]]; then
  pass "preflight (before) exits 1 and reports only the consent-release objects as missing ($(grep -c . <<<"$DRIFT_BEFORE") lines), like production did"
else
  fail "preflight (before) must report ONLY the consent-release objects as missing (exit 1)" \
    "exit $rc; unrelated drift: $(tr '\n' ' ' <<<"${UNRELATED_BEFORE:-<none>}") | output tail: $(tail -n 12 <<<"$PREFLIGHT_BEFORE" | tr '\n' ' ')"
fi

# ════════════════════════════════════════════════════════════════════════════
section "3. production-shaped rows (fictional people, @example.com only)"
# ════════════════════════════════════════════════════════════════════════════
# Volumes follow production's shape on 2026-09-16 (8 customers, 57 bookings,
# 15 leads, 42 sends). The content is invented: no name, address, phone number
# or email below belongs to anyone. Phone numbers are in the 555-01xx range
# reserved for fiction.
q_stdin >/dev/null <<'SQL' || abort "seeding failed"
BEGIN;

INSERT INTO "customers"
  ("id", "email", "name", "phone", "is_first_time", "locale", "marketing_opt_out",
   "email_marketing_consent", "marketing_consent_at", "marketing_consent_source", "marketing_consent_version",
   "created_at", "updated_at")
VALUES
  ('rh_cust_01', 'rehearsal.customer01@example.com', 'Rehearsal Customer 01', '555-0101', false, 'en', false, true,  TIMESTAMP '2026-07-02 10:00:00', 'booking_form', 'booking-2026-07', TIMESTAMP '2026-07-02 10:00:00', TIMESTAMP '2026-08-20 09:00:00'),
  ('rh_cust_02', 'rehearsal.customer02@example.com', 'Rehearsal Customer 02', '555-0102', true,  'es', false, false, NULL, NULL, NULL,                                  TIMESTAMP '2026-07-05 11:00:00', TIMESTAMP '2026-07-05 11:00:00'),
  ('rh_cust_03', 'rehearsal.customer03@example.com', 'Rehearsal Customer 03', '555-0103', true,  'en', false, NULL,  NULL, NULL, NULL,                                  TIMESTAMP '2026-07-09 12:00:00', TIMESTAMP '2026-07-09 12:00:00'),
  ('rh_cust_04', 'rehearsal.customer04@example.com', 'Rehearsal Customer 04', '555-0104', false, 'en', true,  true,  TIMESTAMP '2026-07-12 13:00:00', 'quote_form', 'quote-2026-07', TIMESTAMP '2026-07-12 13:00:00', TIMESTAMP '2026-08-01 08:00:00'),
  ('rh_cust_05', 'rehearsal.customer05@example.com', 'Rehearsal Customer 05', '555-0105', true,  'es', false, true,  TIMESTAMP '2026-08-01 14:00:00', 'booking_form', 'booking-2026-07', TIMESTAMP '2026-08-01 14:00:00', TIMESTAMP '2026-08-01 14:00:00'),
  ('rh_cust_06', 'rehearsal.customer06@example.com', 'Rehearsal Customer 06', '555-0106', true,  'en', false, NULL,  NULL, NULL, NULL,                                  TIMESTAMP '2026-08-10 15:00:00', TIMESTAMP '2026-08-10 15:00:00'),
  ('rh_cust_07', 'rehearsal.customer07@example.com', 'Rehearsal Customer 07', '555-0107', false, 'en', false, false, NULL, NULL, NULL,                                  TIMESTAMP '2026-08-22 16:00:00', TIMESTAMP '2026-09-01 16:00:00'),
  ('rh_cust_08', 'rehearsal.customer08@example.com', 'Rehearsal Customer 08', '555-0108', true,  'en', false, true,  TIMESTAMP '2026-09-10 17:00:00', 'contact_form', 'contact-2026-08', TIMESTAMP '2026-09-10 17:00:00', TIMESTAMP '2026-09-10 17:00:00');

-- Bookings in PENDING_PAYMENT (the abandoned-checkout population, 19),
-- CONFIRMED (19), COMPLETED (10) and CANCELLED (9), each with a customer.
INSERT INTO "bookings"
  ("id", "display_id", "status", "customer_id", "origin_address", "dest_address",
   "requested_date", "confirmed_date", "deposit_paid", "total_estimate", "review_reasons", "address_evaluation",
   "customer_token", "customer_token_expiry", "created_at", "updated_at")
SELECT
  'rh_bkg_' || lpad(i::text, 2, '0'),
  'RH-' || lpad(i::text, 4, '0'),
  s.status::"BookingStatus",
  'rh_cust_' || lpad((1 + i % 8)::text, 2, '0'),
  i::text || ' Rehearsal Origin Way, Fictional Town (not a real address)',
  i::text || ' Rehearsal Destination Road, Fictional Town (not a real address)',
  TIMESTAMP '2026-09-20 09:00:00' + make_interval(days => i),
  CASE WHEN s.status IN ('CONFIRMED', 'COMPLETED') THEN TIMESTAMP '2026-09-20 09:00:00' + make_interval(days => i) END,
  s.status IN ('CONFIRMED', 'COMPLETED'),
  400 + i * 12.5,
  CASE WHEN i % 7 = 0 THEN ARRAY['rehearsal_review_reason'] ELSE ARRAY[]::text[] END,
  jsonb_build_object('zone', 'primary'::text, 'rehearsal', true, 'miles', i),
  'rehearsal-token-' || i::text,
  TIMESTAMP '2026-12-31 00:00:00',
  TIMESTAMP '2026-07-01 12:00:00' + make_interval(hours => i * 20),
  TIMESTAMP '2026-07-01 12:00:00' + make_interval(hours => i * 21)
FROM generate_series(1, 57) AS i
CROSS JOIN LATERAL (
  SELECT (ARRAY['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED'])[1 + i % 6] AS status
) AS s;

-- Leads with an email (12) and without (3); consent true (4) / false (4) /
-- never asked (7); two BOOKED leads point at a booking.
INSERT INTO "crm_leads"
  ("id", "name", "phone", "email", "source", "status", "lost_reason", "lifecycle", "booking_session_id",
   "converted_booking_id", "move_date", "origin_zip", "quote_total_cents",
   "email_marketing_consent", "marketing_consent_at", "marketing_consent_source", "marketing_consent_version", "marketing_consent_prompted",
   "created_at", "updated_at")
SELECT
  'rh_lead_' || lpad(i::text, 2, '0'),
  'Rehearsal Lead ' || i::text,
  '555-01' || lpad((10 + i)::text, 2, '0'),
  CASE WHEN i % 5 = 0 THEN NULL ELSE 'rehearsal.lead' || lpad(i::text, 2, '0') || '@example.com' END,
  (CASE WHEN i % 2 = 0 THEN 'QUICK_QUOTE_FORM' ELSE 'OTHER' END)::"LeadSource",
  st.status::"LeadStatus",
  CASE WHEN st.status = 'LOST' THEN 'NO_RESPONSE'::"LeadLostReason" END,
  ((ARRAY['PARTIAL', 'SUBMITTED', 'IN_PROGRESS', 'CONVERTED', 'ABANDONED'])[1 + i % 5])::"LeadLifecycle",
  'rehearsal-session-' || i::text,
  CASE WHEN st.status = 'BOOKED' THEN 'rh_bkg_' || lpad(i::text, 2, '0') END,
  TIMESTAMP '2026-10-01 00:00:00' + make_interval(days => i),
  '0' || (7000 + i)::text,
  CASE WHEN i % 4 = 0 THEN NULL ELSE 40000 + i * 1000 END,
  c.consent,
  CASE WHEN c.consent THEN TIMESTAMP '2026-08-15 10:00:00' + make_interval(hours => i) END,
  CASE WHEN c.consent IS NOT NULL THEN 'quote_form' END,
  CASE WHEN c.consent IS NOT NULL THEN 'quote-2026-08' END,
  c.consent IS NOT NULL,
  TIMESTAMP '2026-08-15 10:00:00' + make_interval(hours => i),
  TIMESTAMP '2026-08-16 10:00:00' + make_interval(hours => i)
FROM generate_series(1, 15) AS i
CROSS JOIN LATERAL (
  SELECT (ARRAY['NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP', 'BOOKED', 'LOST'])[1 + i % 6] AS status
) AS st
CROSS JOIN LATERAL (
  SELECT CASE WHEN i % 5 = 0 THEN NULL WHEN i % 3 = 0 THEN true WHEN i % 3 = 1 THEN false ELSE NULL END AS consent
) AS c;

-- Sends in all nine statuses email_sends_status_check allows, transactional and
-- promotional, tied to bookings and to leads.
INSERT INTO "email_sends"
  ("id", "idempotency_key", "email", "template", "email_class", "journey", "booking_id", "lead_id",
   "status", "outcome_class", "blocked_reason", "attempts", "next_attempt_at", "provider_id", "error",
   "sent_at", "delivered_at", "bounced_at", "created_at", "updated_at")
SELECT
  'rh_send_' || lpad(i::text, 2, '0'),
  'rehearsal:' || i::text,
  'rehearsal.customer' || lpad((1 + i % 8)::text, 2, '0') || '@example.com',
  (ARRAY['quote-request-received', 'booking-confirmation', 'deposit-receipt', 'quote-followup-1', 'abandoned-checkout-1', 'lead-nurture-1'])[1 + i % 6],
  CASE WHEN i % 6 IN (3, 4, 5) THEN 'promotional' ELSE 'transactional' END,
  CASE i % 6 WHEN 3 THEN 'quote' WHEN 4 THEN 'abandoned' WHEN 5 THEN 'lead-nurture' END,
  CASE WHEN i % 6 IN (1, 2, 4) THEN 'rh_bkg_' || lpad((1 + i % 57)::text, 2, '0') END,
  CASE WHEN i % 6 IN (0, 3, 5) THEN 'rh_lead_' || lpad((1 + i % 15)::text, 2, '0') END,
  s.status,
  CASE
    WHEN s.status IN ('delivered', 'blocked_terminal', 'failed_terminal') THEN 'terminal'
    WHEN s.status = 'ambiguous' THEN 'ambiguous'
    WHEN s.status = 'sending' THEN NULL
    ELSE 'retryable'
  END,
  CASE WHEN s.status LIKE 'blocked%' THEN 'rehearsal_block' END,
  CASE WHEN s.status = 'sending' THEN 0 ELSE 1 + i % 3 END,
  CASE WHEN s.status IN ('retry_pending', 'deferred', 'blocked_retryable') THEN TIMESTAMP '2026-09-17 08:00:00' END,
  CASE WHEN s.status IN ('delivered', 'ambiguous') THEN 'rehearsal-provider-' || i::text END,
  CASE WHEN s.status IN ('provider_rejected', 'failed_terminal') THEN 'rehearsal provider error' END,
  CASE WHEN s.status = 'delivered' THEN TIMESTAMP '2026-08-01 09:00:00' + make_interval(hours => i) END,
  CASE WHEN s.status = 'delivered' AND i % 4 <> 0 THEN TIMESTAMP '2026-08-01 09:00:05' + make_interval(hours => i) END,
  CASE WHEN s.status = 'delivered' AND i % 4 = 0 THEN TIMESTAMP '2026-08-01 09:00:07' + make_interval(hours => i) END,
  TIMESTAMP '2026-08-01 08:59:00' + make_interval(hours => i),
  TIMESTAMP '2026-08-01 09:01:00' + make_interval(hours => i)
FROM generate_series(1, 42) AS i
CROSS JOIN LATERAL (
  SELECT (ARRAY['delivered', 'delivered', 'delivered', 'sending', 'provider_rejected', 'retry_pending',
                'ambiguous', 'deferred', 'blocked_retryable', 'blocked_terminal', 'failed_terminal'])[1 + i % 11] AS status
) AS s;

INSERT INTO "email_suppressions" ("id", "email", "reason", "scope", "source", "detail", "created_at", "updated_at")
VALUES
  ('rh_sup_1', 'rehearsal.customer04@example.com', 'UNSUBSCRIBED',      'promotional', 'unsubscribe_link', NULL,                    TIMESTAMP '2026-08-01 08:00:00', TIMESTAMP '2026-08-01 08:00:00'),
  ('rh_sup_2', 'rehearsal.lead07@example.com',     'HARD_BOUNCE',       'all',         'provider_webhook', 'rehearsal bounce',      TIMESTAMP '2026-08-05 08:00:00', TIMESTAMP '2026-08-05 08:00:00'),
  ('rh_sup_3', 'rehearsal.lead11@example.com',     'SPAM_COMPLAINT',    'all',         'provider_webhook', 'rehearsal complaint',   TIMESTAMP '2026-08-09 08:00:00', TIMESTAMP '2026-08-09 08:00:00'),
  ('rh_sup_4', 'rehearsal.blocked@example.com',    'ADMIN_BLOCK',       'promotional', 'admin',            'rehearsal admin block', TIMESTAMP '2026-08-12 08:00:00', TIMESTAMP '2026-08-12 08:00:00'),
  ('rh_sup_5', 'rehearsal.invalid@example.com',    'INVALID_ADDRESS',   'all',         'send_guard',       NULL,                    TIMESTAMP '2026-08-20 08:00:00', TIMESTAMP '2026-08-20 08:00:00'),
  ('rh_sup_6', 'rehearsal.rejected@example.com',   'PROVIDER_REJECTED', 'all',         'provider_webhook', 'rehearsal rejection',   TIMESTAMP '2026-09-02 08:00:00', TIMESTAMP '2026-09-02 08:00:00');

COMMIT;
SQL
pass "seeded customers, bookings, crm_leads, email_sends and email_suppressions"

expect_eq "every seeded address is @example.com (or absent)" "0" \
  "$(q "SELECT count(*) FROM (
          SELECT email FROM customers UNION ALL SELECT email FROM crm_leads WHERE email IS NOT NULL
          UNION ALL SELECT email FROM email_sends UNION ALL SELECT email FROM email_suppressions
        ) e WHERE email !~* '@example\.com\$'")"
expect_eq "seeded shape: customers|bookings(PENDING_PAYMENT,CONFIRMED)|leads(with email,without)|sends(distinct statuses)|suppressions" \
  "8|57(19,19)|15(12,3)|42(9)|6" \
  "$(q "SELECT (SELECT count(*) FROM customers)
         || '|' || (SELECT count(*) FROM bookings) || '(' || (SELECT count(*) FROM bookings WHERE status = 'PENDING_PAYMENT') || ',' || (SELECT count(*) FROM bookings WHERE status = 'CONFIRMED') || ')'
         || '|' || (SELECT count(*) FROM crm_leads) || '(' || (SELECT count(*) FROM crm_leads WHERE email IS NOT NULL) || ',' || (SELECT count(*) FROM crm_leads WHERE email IS NULL) || ')'
         || '|' || (SELECT count(*) FROM email_sends) || '(' || (SELECT count(DISTINCT status) FROM email_sends) || ')'
         || '|' || (SELECT count(*) FROM email_suppressions)")"

# ── the "before" record ─────────────────────────────────────────────────────
# Row counts of EVERY table, and a checksum over EVERY pre-release column of the
# seeded tables. Both SQL texts are frozen NOW, so the new tables and the four
# new columns cannot change either result by merely existing.
COUNT_SQL="$(q "SELECT string_agg(format('SELECT %L || ''='' || count(*) FROM %I', table_name, table_name), ' UNION ALL ' ORDER BY table_name)
                 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'")"
[[ -n "$COUNT_SQL" ]] || abort "could not list the tables to count"
CHECKSUM_SQL=""
for t in customers bookings crm_leads email_sends email_suppressions; do
  cols="$(q "SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
               FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '$t'")"
  [[ -n "$cols" ]] || abort "could not read the columns of $t"
  [[ -z "$CHECKSUM_SQL" ]] || CHECKSUM_SQL+=" UNION ALL "
  CHECKSUM_SQL+="SELECT '$t=' || count(*) || ':' || md5(coalesce(string_agg((ROW($cols))::text, chr(10) ORDER BY \"id\"), '')) FROM \"$t\""
done
SNAPSHOT_SQL="$(cat <<'SQL'
SELECT line FROM (
  SELECT 'relation|' || c.relname || '|' || c.relkind::text AS line
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  UNION ALL
  SELECT 'column|' || table_name || '|' || column_name || '|' || data_type || '|' || udt_name || '|' || is_nullable || '|' || coalesce(column_default, '')
    FROM information_schema.columns WHERE table_schema = 'public'
  UNION ALL
  SELECT 'index|' || tablename || '|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'constraint|' || cl.relname || '|' || co.conname || '|' || pg_get_constraintdef(co.oid)
    FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid WHERE co.connamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'trigger|' || cl.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid WHERE NOT t.tgisinternal AND cl.relnamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || md5(pg_get_functiondef(p.oid))
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
  UNION ALL
  SELECT 'enum|' || t.typname || '|' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname
) s
SQL
)"
# A table rewrite gives the table a new relfilenode. ADD COLUMN of a nullable
# column with no default must not rewrite (it is a catalog change only).
REWRITE_SQL="SELECT string_agg(relname || '=' || relfilenode::text, ',' ORDER BY relname) FROM pg_class
               WHERE relnamespace = 'public'::regnamespace AND relname IN ('bookings', 'crm_leads', 'email_sends')"
HISTORY_SQL="SELECT count(*) FROM \"_prisma_migrations\""

COUNTS_BEFORE="$(q "$COUNT_SQL" | LC_ALL=C sort)"
CHECKSUMS_BEFORE="$(q "$CHECKSUM_SQL" | LC_ALL=C sort)"
q "$SNAPSHOT_SQL" | LC_ALL=C sort > "$WORK/schema.before"
FILENODES_BEFORE="$(q "$REWRITE_SQL")"
HISTORY_BEFORE="$(q "$HISTORY_SQL")"
IDS_BEFORE="$(q "SELECT string_agg(quote_literal(id), ',' ORDER BY id) FROM \"_prisma_migrations\"")"
echo "   recorded: $(grep -c . <<<"$COUNTS_BEFORE") table row counts, $(wc -l < "$WORK/schema.before" | tr -d ' ') schema lines, ${HISTORY_BEFORE} _prisma_migrations rows"
echo "   seeded-row checksums (table=rows:md5 over every pre-release column):"
sed 's/^/     /' <<<"$CHECKSUMS_BEFORE"

# ════════════════════════════════════════════════════════════════════════════
section "4. THE DEPLOY — \`npx prisma migrate deploy\`, the full migrations directory, as production runs it"
# ════════════════════════════════════════════════════════════════════════════
rc=0
t0="$(now_ms)"
DEPLOY_OUT="$(prisma_owner migrate deploy)" || rc=$?
t1="$(now_ms)"
MIGRATION_MS_WALL=$((t1 - t0))
sed 's/^/   | /' <<<"$DEPLOY_OUT"
if [[ $rc -ne 0 ]]; then
  abort "npx prisma migrate deploy FAILED (exit $rc) — production would record ${MIGRATION} as failed and block every later deploy (P3009)"
fi
if contains "$DEPLOY_OUT" "$MIGRATION" && contains "$DEPLOY_OUT" "All migrations have been successfully applied."; then
  pass "migrate deploy exited 0 and applied ${MIGRATION}"
else
  fail "migrate deploy exited 0 but did not report applying ${MIGRATION}"
fi

expect_eq "_prisma_migrations grew by exactly one row" "$((HISTORY_BEFORE + 1))" "$(q "$HISTORY_SQL")"
expect_eq "the one new _prisma_migrations row is ${MIGRATION}" "1|$MIGRATION" \
  "$(q "SELECT count(*) || '|' || coalesce(string_agg(migration_name, ','), '') FROM \"_prisma_migrations\" WHERE id NOT IN ($IDS_BEFORE)")"
expect_eq "the row is finished, not rolled back, has no error log and ran its one step" "finished|not-rolled-back|no-logs|1" \
  "$(q "SELECT CASE WHEN finished_at IS NOT NULL THEN 'finished' ELSE 'unfinished' END
            || '|' || CASE WHEN rolled_back_at IS NULL THEN 'not-rolled-back' ELSE 'rolled-back' END
            || '|' || CASE WHEN logs IS NULL THEN 'no-logs' ELSE 'has-logs' END
            || '|' || applied_steps_count
          FROM \"_prisma_migrations\" WHERE migration_name = '$MIGRATION'")"
FILE_SHA="$(sha256_of "$HERE/prisma/migrations/$MIGRATION/migration.sql")"
expect_eq "recorded checksum = SHA-256 of the committed file bytes" "$FILE_SHA" \
  "$(q "SELECT checksum FROM \"_prisma_migrations\" WHERE migration_name = '$MIGRATION'")"
echo "   checksum recorded: $FILE_SHA"
echo "   (LF bytes; deploying from a CRLF Windows checkout records a DIFFERENT checksum for the same migration)"
MIGRATION_MS_SERVER="$(q "SELECT round(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::bigint FROM \"_prisma_migrations\" WHERE migration_name = '$MIGRATION'")"
echo "   migration took ${MIGRATION_MS_SERVER} ms in the database, ${MIGRATION_MS_WALL} ms wall-clock (CLI start-up included)"

# ════════════════════════════════════════════════════════════════════════════
section "5. the new objects exist, exactly as specified"
# ════════════════════════════════════════════════════════════════════════════
expect_eq "tables email_consent_events, email_marketing_status, sequence_enrollments" \
  "email_consent_events,email_marketing_status,sequence_enrollments" \
  "$(q "SELECT string_agg(table_name::text, ',' ORDER BY table_name::text COLLATE \"C\") FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           AND table_name IN ('email_consent_events', 'email_marketing_status', 'sequence_enrollments')")"

expect_eq "the four new columns are TEXT, NULLABLE and have NO default" \
  "bookings.basis_event_id:text:YES:none,crm_leads.basis_event_id:text:YES:none,email_sends.basis_event_id:text:YES:none,email_sends.marketing_basis:text:YES:none" \
  "$(q "SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, 'none'), ','
                         ORDER BY (table_name || '.' || column_name) COLLATE \"C\")
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND ((table_name IN ('crm_leads', 'bookings') AND column_name = 'basis_event_id')
             OR (table_name = 'email_sends' AND column_name IN ('basis_event_id', 'marketing_basis')))")"

EXPECTED_INDEXES="email_consent_events_email_normalized_occurred_at_idx:plain,email_consent_events_ip_hmac_occurred_at_idx:plain,email_consent_events_kind_occurred_at_idx:plain,email_consent_events_pkey:unique,email_consent_events_request_id_kind_key:unique,email_marketing_status_pkey:unique,sequence_enrollments_email_normalized_sequence_kind_window__key:unique,sequence_enrollments_email_normalized_status_idx:plain,sequence_enrollments_pkey:unique,sequence_enrollments_subject_type_subject_id_idx:plain"
expect_eq "all 10 indexes on the new tables exist and are VALID (unique where specified)" "$EXPECTED_INDEXES" \
  "$(q "SELECT string_agg(c.relname || ':' || CASE WHEN i.indisunique THEN 'unique' ELSE 'plain' END, ',' ORDER BY c.relname COLLATE \"C\")
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
         WHERE t.relnamespace = 'public'::regnamespace AND i.indisvalid AND i.indisready
           AND t.relname IN ('email_consent_events', 'email_marketing_status', 'sequence_enrollments')")"
expect_eq "unique (request_id, kind) and unique (email_normalized, sequence_kind, window_start) cover exactly those columns" \
  "email_consent_events_request_id_kind_key(request_id, kind)|sequence_enrollments_email_normalized_sequence_kind_window__key(email_normalized, sequence_kind, window_start)" \
  "$(q "SELECT string_agg(indexname || substring(indexdef FROM '\(.*\)\$'), '|' ORDER BY indexname COLLATE \"C\") FROM pg_indexes
         WHERE schemaname = 'public' AND indexname IN ('email_consent_events_request_id_kind_key', 'sequence_enrollments_email_normalized_sequence_kind_window__key')")"

# tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32.
# 27 = BEFORE, FOR EACH ROW, on UPDATE and DELETE — and not on INSERT or TRUNCATE.
expect_eq "append-only trigger: enabled, BEFORE UPDATE OR DELETE, FOR EACH ROW, calling email_consent_events_refuse_change()" \
  "O|27|email_consent_events_refuse_change" \
  "$(q "SELECT t.tgenabled::text || '|' || t.tgtype::text || '|' || p.proname FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE c.relname = 'email_consent_events' AND c.relnamespace = 'public'::regnamespace
           AND t.tgname = 'email_consent_events_append_only' AND NOT t.tgisinternal")"
expect_eq "functions email_consent_events_refuse_change() -> trigger and redact_email_consent(text) -> integer" \
  "email_consent_events_refuse_change()->trigger,redact_email_consent(p_email text)->integer" \
  "$(q "SELECT string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')->' || format_type(prorettype, NULL), ',' ORDER BY proname COLLATE \"C\")
          FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('email_consent_events_refuse_change', 'redact_email_consent')")"
KIND_CHECK="$(q "SELECT co.contype::text || '|' || CASE WHEN co.convalidated THEN 'validated' ELSE 'not-validated' END || '|' || pg_get_constraintdef(co.oid)
                   FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid
                  WHERE co.conname = 'email_consent_events_kind_check' AND c.relname = 'email_consent_events'")"
KIND_OK=1
[[ "$KIND_CHECK" == "c|validated|CHECK"* ]] || KIND_OK=0
for kind in notice_accepted express_opt_in opted_out_at_capture declined_at_capture unsubscribed resubscribed basis_withheld; do
  contains "$KIND_CHECK" "'$kind'" || KIND_OK=0
done
if [[ $KIND_OK -eq 1 ]]; then
  pass "CHECK email_consent_events_kind_check exists, is validated and lists all 7 kinds"
else
  fail "CHECK email_consent_events_kind_check missing or wrong" "$KIND_CHECK"
fi

# One implicit transaction: Prisma sends the whole file as one multi-statement
# simple query, which PostgreSQL runs as a single transaction. Every catalog row
# the migration created therefore carries ONE xmin. This is what makes a
# mid-file failure roll back completely — and it means the ACCESS EXCLUSIVE
# locks on bookings, crm_leads and email_sends are held until the LAST
# statement commits, not just for their own ALTER.
expect_eq "the whole migration committed as ONE transaction (all created catalog rows share one xmin)" "1" \
  "$(q "SELECT count(DISTINCT x) FROM (
          SELECT xmin::text AS x FROM pg_class WHERE relnamespace = 'public'::regnamespace
             AND relname IN ('email_consent_events', 'email_marketing_status', 'sequence_enrollments')
          UNION ALL SELECT a.xmin::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('crm_leads', 'bookings', 'email_sends')
             AND a.attname IN ('basis_event_id', 'marketing_basis')
          UNION ALL SELECT xmin::text FROM pg_trigger WHERE tgname = 'email_consent_events_append_only'
          UNION ALL SELECT xmin::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace
             AND proname IN ('email_consent_events_refuse_change', 'redact_email_consent')
          UNION ALL SELECT xmin::text FROM pg_constraint WHERE conname = 'email_consent_events_kind_check'
        ) s")"

# ════════════════════════════════════════════════════════════════════════════
section "6. existing data is untouched and nothing is backfilled"
# ════════════════════════════════════════════════════════════════════════════
expect_eq "row counts of every pre-existing table are unchanged" "$COUNTS_BEFORE" "$(q "$COUNT_SQL" | LC_ALL=C sort)"
expect_eq "checksums over every pre-release column of the seeded tables are unchanged" "$CHECKSUMS_BEFORE" "$(q "$CHECKSUM_SQL" | LC_ALL=C sort)"
expect_eq "crm_leads.basis_event_id is NULL on all 15 pre-existing rows" "15|0" \
  "$(q "SELECT count(*) || '|' || count(basis_event_id) FROM crm_leads")"
expect_eq "bookings.basis_event_id is NULL on all 57 pre-existing rows" "57|0" \
  "$(q "SELECT count(*) || '|' || count(basis_event_id) FROM bookings")"
expect_eq "email_sends.basis_event_id is NULL on all 42 pre-existing rows" "42|0" \
  "$(q "SELECT count(*) || '|' || count(basis_event_id) FROM email_sends")"
expect_eq "email_sends.marketing_basis is NULL on all 42 pre-existing rows" "42|0" \
  "$(q "SELECT count(*) || '|' || count(marketing_basis) FROM email_sends")"
expect_eq "the three new tables are empty (no evidence, status or enrollment was invented)" "0|0|0" \
  "$(q "SELECT (SELECT count(*) FROM email_consent_events) || '|' || (SELECT count(*) FROM email_marketing_status) || '|' || (SELECT count(*) FROM sequence_enrollments)")"
expect_eq "no table rewrite: bookings, crm_leads and email_sends keep their storage (ADD COLUMN was catalog-only)" \
  "$FILENODES_BEFORE" "$(q "$REWRITE_SQL")"

q "$SNAPSHOT_SQL" | LC_ALL=C sort > "$WORK/schema.after"
REMOVED="$(LC_ALL=C comm -23 "$WORK/schema.before" "$WORK/schema.after")"
ADDED="$(LC_ALL=C comm -13 "$WORK/schema.before" "$WORK/schema.after")"
UNEXPECTED_ADDED="$(grep -Ev 'basis_event_id|marketing_basis|email_consent_events|email_marketing_status|sequence_enrollments|redact_email_consent' <<<"$ADDED" || true)"
if [[ -z "$REMOVED" ]]; then
  pass "purely additive: no pre-existing table, column, default, index, constraint, trigger, function or enum changed or disappeared"
else
  fail "a pre-existing schema object changed or disappeared" "$(tr '\n' ' ' <<<"$REMOVED")"
fi
if [[ -n "$ADDED" && -z "$UNEXPECTED_ADDED" ]]; then
  pass "everything added belongs to the consent release ($(grep -c . <<<"$ADDED") schema lines)"
else
  fail "the deploy added schema objects outside the consent release" "$(tr '\n' ' ' <<<"${UNEXPECTED_ADDED:-<nothing was added>}")"
fi

# ════════════════════════════════════════════════════════════════════════════
section "7. the evidence table behaves as specified — for the owner role"
# ════════════════════════════════════════════════════════════════════════════
expect_refused() {
  local label="$1" sql="$2" pattern="$3" err="$WORK/probe.err"
  if "${PSQL[@]}" "$OWNER_PSQL_URL" -c "$sql" >/dev/null 2>"$err"; then
    fail "$label" "the statement SUCCEEDED; it must be refused"
  elif grep -Eq -- "$pattern" "$err"; then
    pass "$label"
  else
    fail "$label" "refused, but not for the expected reason: $(tr '\n' ' ' < "$err")"
  fi
}

q "INSERT INTO email_consent_events (id, email_normalized, kind, surface, notice_version, notice_copy_sha256, locale, opt_out_box, request_id, occurred_at)
   VALUES ('rh_evt_1', 'rehearsal.probe@example.com', 'notice_accepted', 'quote', 'quote-rehearsal-r2', repeat('a', 64), 'en', false, 'rehearsal-request-1', TIMESTAMPTZ '2026-09-16 12:00:00+00')" >/dev/null \
  || abort "a valid consent event could not be inserted as the owner role"
pass "a valid consent event inserts"
EVENT_BEFORE="$(q "SELECT e::text FROM email_consent_events e WHERE id = 'rh_evt_1'")"

expect_refused "UPDATE on email_consent_events is refused (append-only)" \
  "UPDATE email_consent_events SET opt_out_box = true WHERE id = 'rh_evt_1'" \
  "append-only: UPDATE refused"
expect_refused "DELETE on email_consent_events is refused (append-only)" \
  "DELETE FROM email_consent_events WHERE id = 'rh_evt_1'" \
  "append-only: DELETE refused"
expect_eq "the refused UPDATE and DELETE left the event exactly as written" "$EVENT_BEFORE" \
  "$(q "SELECT e::text FROM email_consent_events e WHERE id = 'rh_evt_1'")"
expect_refused "a kind outside the vocabulary is refused by the CHECK" \
  "INSERT INTO email_consent_events (id, email_normalized, kind, surface, request_id) VALUES ('rh_evt_bad', 'rehearsal.probe@example.com', 'not_a_kind', 'quote', 'rehearsal-request-2')" \
  "email_consent_events_kind_check"
expect_refused "a retried request (same request_id and kind) records only once" \
  "INSERT INTO email_consent_events (id, email_normalized, kind, surface, request_id) VALUES ('rh_evt_dup', 'rehearsal.probe@example.com', 'notice_accepted', 'quote', 'rehearsal-request-1')" \
  "email_consent_events_request_id_kind_key"
q "INSERT INTO sequence_enrollments (id, email_normalized, sequence_kind, subject_type, subject_id, window_start, updated_at)
   VALUES ('rh_enr_1', 'rehearsal.probe@example.com', 'lead_nurture', 'lead', 'rh_lead_01', DATE '2026-09-16', now())" >/dev/null \
  || abort "a valid enrollment could not be inserted as the owner role"
expect_refused "a second enrollment for the same person, sequence and window is refused" \
  "INSERT INTO sequence_enrollments (id, email_normalized, sequence_kind, subject_type, subject_id, window_start, updated_at) VALUES ('rh_enr_2', 'rehearsal.probe@example.com', 'lead_nurture', 'lead', 'rh_lead_02', DATE '2026-09-16', now())" \
  "sequence_enrollments_email_normalized_sequence_kind_window__key"
q "INSERT INTO email_marketing_status (email_normalized, last_notice_at, last_notice_event_id, updated_at)
   VALUES ('rehearsal.probe@example.com', TIMESTAMPTZ '2026-09-16 12:00:00+00', 'rh_evt_1', now())" >/dev/null \
  || abort "a valid marketing status could not be inserted as the owner role"

# Erasure is the ONE permitted change. It must work for the owner role, keep
# the evidence fields, and leave no redaction flag behind. The function call and
# the checks are separate statements: a check in the same statement would read
# the pre-function snapshot and still see the deleted enrollment.
expect_eq "redact_email_consent() redacts the one event (normalizing case and spaces)" "1" \
  "$(q "SELECT redact_email_consent('  Rehearsal.Probe@EXAMPLE.com ')")"
# The expected hash is computed OUTSIDE the database, so the SQL is not checked
# against itself.
printf '%s' 'rehearsal.probe@example.com' > "$WORK/probe.address"
PROBE_HASH="redacted:sha256:$(sha256_of "$WORK/probe.address")"
expect_eq "after erasure: no enrollment and no plain-address status remain; the status row is re-keyed to the hash" "0|0|1" \
  "$(q "SELECT (SELECT count(*) FROM sequence_enrollments WHERE email_normalized = 'rehearsal.probe@example.com')
          || '|' || (SELECT count(*) FROM email_marketing_status WHERE email_normalized = 'rehearsal.probe@example.com')
          || '|' || (SELECT count(*) FROM email_marketing_status WHERE email_normalized = '$PROBE_HASH')")"
expect_eq "after erasure the address is a SHA-256 and kind, surface, notice, copy hash, request id and time are kept" \
  "$PROBE_HASH|notice_accepted|quote|quote-rehearsal-r2|copy-hash-kept|rehearsal-request-1|2026-09-16 12:00:00" \
  "$(q "SELECT email_normalized || '|' || kind || '|' || surface || '|' || notice_version
            || '|' || CASE WHEN notice_copy_sha256 = repeat('a', 64) THEN 'copy-hash-kept' ELSE 'copy-hash-changed' END
            || '|' || request_id || '|' || to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          FROM email_consent_events WHERE id = 'rh_evt_1'")"
# In ONE transaction (psql -c runs a multi-statement string as one): an erasure,
# then an UPDATE that the flag WOULD permit (evidence fields unchanged, address
# already a hash). Refused = the function switched its flag off again.
expect_refused "right after an erasure, in the same transaction, a plain UPDATE is refused (the flag is switched off)" \
  "SELECT redact_email_consent('rehearsal.nobody@example.com'); UPDATE email_consent_events SET email_normalized = 'redacted:sha256:tampered' WHERE id = 'rh_evt_1'" \
  "append-only: UPDATE refused"
expect_refused "setting the redaction flag by hand still cannot change an evidence field" \
  "SET email_consent.redacting = 'on'; UPDATE email_consent_events SET surface = 'tampered' WHERE id = 'rh_evt_1'" \
  "append-only: UPDATE refused"

# ════════════════════════════════════════════════════════════════════════════
section "8. a second deploy is a no-op"
# ════════════════════════════════════════════════════════════════════════════
q "$SNAPSHOT_SQL" | LC_ALL=C sort > "$WORK/schema.deployed"
HISTORY_DEPLOYED="$(q "$HISTORY_SQL")"
rc=0
DEPLOY2_OUT="$(prisma_owner migrate deploy)" || rc=$?
if [[ $rc -eq 0 ]] && contains "$DEPLOY2_OUT" "No pending migrations to apply."; then
  pass "second migrate deploy exits 0: \"No pending migrations to apply.\""
else
  fail "second migrate deploy must be a no-op" "exit $rc: $(tail -n 12 <<<"$DEPLOY2_OUT" | tr '\n' ' ')"
fi
expect_eq "second deploy wrote no _prisma_migrations row" "$HISTORY_DEPLOYED" "$(q "$HISTORY_SQL")"
q "$SNAPSHOT_SQL" | LC_ALL=C sort > "$WORK/schema.deploy2"
if cmp -s "$WORK/schema.deployed" "$WORK/schema.deploy2"; then
  pass "second deploy changed no schema object"
else
  fail "second deploy changed the schema" "$(LC_ALL=C diff "$WORK/schema.deployed" "$WORK/schema.deploy2" | tr '\n' ' ')"
fi

# The file's header claims it is RE-RUNNABLE. That matters when a failed deploy is
# recovered by hand. Prove it: execute the SQL again, verbatim, in one
# transaction (as Prisma does), on the populated, already-migrated database.
EVENTS_BEFORE_RERUN="$(q "SELECT count(*) || ':' || md5(coalesce(string_agg(e::text, chr(10) ORDER BY id), '')) FROM email_consent_events e")"
if "${PSQL[@]}" "$OWNER_PSQL_URL" -1 -f "$HERE/prisma/migrations/$MIGRATION/migration.sql" >/dev/null 2>"$WORK/rerun.err"; then
  pass "executing migration.sql again on the migrated, populated database succeeds (re-runnable as claimed)"
else
  fail "migration.sql is NOT re-runnable" "$(tr '\n' ' ' < "$WORK/rerun.err")"
fi
q "$SNAPSHOT_SQL" | LC_ALL=C sort > "$WORK/schema.rerun"
if cmp -s "$WORK/schema.deployed" "$WORK/schema.rerun"; then
  pass "re-running the SQL changed no schema object"
else
  fail "re-running the SQL changed the schema" "$(LC_ALL=C diff "$WORK/schema.deployed" "$WORK/schema.rerun" | tr '\n' ' ')"
fi
expect_eq "re-running the SQL touched no existing row or consent event" \
  "$CHECKSUMS_BEFORE|$EVENTS_BEFORE_RERUN" \
  "$(q "$CHECKSUM_SQL" | LC_ALL=C sort)|$(q "SELECT count(*) || ':' || md5(coalesce(string_agg(e::text, chr(10) ORDER BY id), '')) FROM email_consent_events e")"

# ════════════════════════════════════════════════════════════════════════════
section "9. the operator's post-deploy checks (DEPLOY.md §10)"
# ════════════════════════════════════════════════════════════════════════════
# email-schema-preflight.ts takes no target argument; it reads DATABASE_URL
# through src/lib/db.ts, so it is pointed at ci_prodlike through the environment
# of this one command. It is read-only.
rc=0
PREFLIGHT_AFTER="$(preflight_owner)" || rc=$?
sed 's/^/   | /' <<<"$PREFLIGHT_AFTER"
if [[ $rc -eq 0 ]] && contains "$PREFLIGHT_AFTER" "No drift." && ! grep -Eq '^[[:space:]]*DRIFT ' <<<"$PREFLIGHT_AFTER"; then
  pass "npx tsx scripts/email-schema-preflight.ts reports no drift"
else
  fail "email-schema-preflight must report no drift after the deploy" "exit $rc"
fi

# With production's four database-only migrations recorded, Prisma classifies the
# history as "migrations directory is behind", which `migrate status` does not
# treat as an error: exit 0 and "up to date" once nothing is pending.
rc=0
STATUS_AFTER="$(prisma_owner migrate status)" || rc=$?
sed 's/^/   | /' <<<"$STATUS_AFTER"
if [[ $rc -eq 0 ]] && contains "$STATUS_AFTER" "Database schema is up to date!"; then
  pass "npx prisma migrate status exits 0: \"Database schema is up to date!\" (with production's history shape)"
else
  fail "migrate status must be clean after the deploy" "exit $rc"
fi

# on_exit prints the summary, sets the exit code and cleans up.
exit 0
