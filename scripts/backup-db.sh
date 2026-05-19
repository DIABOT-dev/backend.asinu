#!/usr/bin/env bash
#
# Postgres backup script.
#
# Requires: pg_dump, gzip. Optional: aws CLI (for S3 upload).
#
# Env vars:
#   DATABASE_URL          (required) — connection string for pg_dump
#   BACKUP_DIR            (optional) — local directory, default /var/backups/asinu
#   BACKUP_RETENTION_DAYS (optional) — local retention, default 14
#   S3_BUCKET             (optional) — if set, uploads to s3://$S3_BUCKET/asinu/
#   AWS_S3_ENDPOINT       (optional) — for Cloudflare R2 or other S3-compatible hosts
#
# Schedule via cron, e.g.:
#   0 3 * * *  /opt/asinu/scripts/backup-db.sh >> /var/log/asinu-backup.log 2>&1

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/asinu}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TS=$(date -u +'%Y%m%dT%H%M%SZ')
OUT="${BACKUP_DIR}/asinu-${TS}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date -u +%FT%TZ)] Starting backup -> $OUT"

# --no-owner / --no-privileges keeps the dump portable across environments.
pg_dump --no-owner --no-privileges --format=plain "$DATABASE_URL" | gzip -9 > "$OUT"

SIZE=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
echo "[$(date -u +%FT%TZ)] Backup complete: $OUT (${SIZE} bytes)"

# Optional: upload to S3-compatible storage.
if [ -n "${S3_BUCKET:-}" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "[$(date -u +%FT%TZ)] WARN: S3_BUCKET set but 'aws' CLI not found, skipping upload" >&2
  else
    DEST="s3://${S3_BUCKET}/asinu/$(basename "$OUT")"
    AWS_ARGS=(s3 cp "$OUT" "$DEST" --storage-class STANDARD_IA)
    if [ -n "${AWS_S3_ENDPOINT:-}" ]; then
      AWS_ARGS+=(--endpoint-url "$AWS_S3_ENDPOINT")
    fi
    aws "${AWS_ARGS[@]}"
    echo "[$(date -u +%FT%TZ)] Uploaded to $DEST"
  fi
fi

# Prune local backups older than RETENTION_DAYS days.
find "$BACKUP_DIR" -type f -name 'asinu-*.sql.gz' -mtime +"$RETENTION_DAYS" -print -delete

echo "[$(date -u +%FT%TZ)] Done."
