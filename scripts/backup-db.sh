#!/usr/bin/env bash
# Backup the PostgreSQL database to a timestamped file.
# Requires pg_dump and a DATABASE_URL environment variable.
# Schedule via cron: 0 3 * * * /path/to/backend/scripts/backup-db.sh
#
# Example DATABASE_URL format:
#   postgresql://user:password@host:5432/dbname
#
# TO RESTORE (the file is COMPRESSED — see the note below):
#   gunzip -c backup_YYYYMMDD_HHMMSS.sql.gz | psql "$DATABASE_URL"
#
# The header used to document `psql $DATABASE_URL < backup-file.sql`, while the
# script gzips its output as its last step. Run literally, that feeds compressed
# bytes to psql and fails — the kind of thing discovered at 3 a.m. during the one
# restore that matters. Fixed 2026-08-28, found by scripts/release-rehearsal.ts.
#
# AFTER RESTORING, CHECK THE PARTIAL UNIQUE INDEX. It exists only in
# hand-written SQL (Prisma cannot express a partial unique index), so it is the
# thing most likely to go missing without anything failing:
#   \di crm_leads_open_booking_session_key
# If it is absent, re-apply
# prisma/migrations/20260825150000_lead_session_unique/migration.sql — until you
# do, two concurrent captures on one browser session can create duplicate leads.

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.sql"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set" >&2
  exit 1
fi

# ── VERSION PREFLIGHT ────────────────────────────────────────────────────────
# pg_dump REFUSES to dump a server newer than itself. Without this check the
# failure mode is silent in the way that matters: the cron job exits non-zero,
# nobody is watching cron, and the backup directory simply stops gaining files.
# The first person to notice is whoever needs a restore.
#
# This turns "no new backups appeared" into a loud, specific message naming both
# versions, so an upgraded managed database (Neon, RDS) that has moved ahead of
# the host's client tools is diagnosable in one line instead of one incident.
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "Error: pg_dump is not on PATH. Install the PostgreSQL client tools." >&2
  exit 1
fi

CLIENT_VERSION=$(pg_dump --version | grep -oE '[0-9]+(\.[0-9]+)*' | head -1)
SERVER_VERSION=$(psql "$DATABASE_URL" -tAc "SELECT current_setting('server_version')" 2>/dev/null \
  | grep -oE '^[0-9]+(\.[0-9]+)*' || echo "")

if [[ -n "$SERVER_VERSION" ]]; then
  CLIENT_MAJOR="${CLIENT_VERSION%%.*}"
  SERVER_MAJOR="${SERVER_VERSION%%.*}"
  if (( CLIENT_MAJOR < SERVER_MAJOR )); then
    echo "Error: pg_dump ${CLIENT_VERSION} cannot dump a PostgreSQL ${SERVER_VERSION} server." >&2
    echo "       pg_dump refuses to dump a server newer than itself, so NO BACKUP WAS TAKEN." >&2
    echo "       Upgrade the PostgreSQL client tools on this host to ${SERVER_MAJOR} or later." >&2
    exit 1
  fi
else
  # Not fatal: the dump itself will fail loudly if the server is unreachable.
  echo "Warning: could not read the server version; proceeding to pg_dump." >&2
fi

mkdir -p "$BACKUP_DIR"

echo "Starting backup at $(date)..."
pg_dump "$DATABASE_URL" \
  --no-owner \
  --no-privileges \
  --if-exists \
  --clean \
  --format=plain \
  --file="$BACKUP_FILE"

# Compress
gzip "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"

# ── THE BACKUP MUST NOT BE EMPTY ─────────────────────────────────────────────
# A zero-length or near-empty file is the worst outcome: it looks like a backup
# in every listing and restores nothing. 1 KB is far below any real dump of this
# schema and far above an empty gzip header.
BYTES=$(wc -c < "$BACKUP_FILE")
if (( BYTES < 1024 )); then
  echo "Error: backup file is only ${BYTES} bytes — refusing to call this a backup." >&2
  exit 1
fi

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "✓ Backup written: $BACKUP_FILE ($SIZE)"

# Remove backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "backup_*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
echo "✓ Cleaned up backups older than ${KEEP_DAYS} days"

echo "Backup complete at $(date)"
