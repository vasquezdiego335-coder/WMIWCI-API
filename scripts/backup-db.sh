#!/usr/bin/env bash
# Backup the PostgreSQL database to a timestamped file.
# Requires pg_dump and a DATABASE_URL environment variable.
# Schedule via cron: 0 3 * * * /path/to/backend/scripts/backup-db.sh
#
# Example DATABASE_URL format:
#   postgresql://user:password@host:5432/dbname
#
# To restore: psql $DATABASE_URL < backup-file.sql

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.sql"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set" >&2
  exit 1
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

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "✓ Backup written: $BACKUP_FILE ($SIZE)"

# Remove backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "backup_*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
echo "✓ Cleaned up backups older than ${KEEP_DAYS} days"

echo "Backup complete at $(date)"
