#!/usr/bin/env bash
# Only the public age recipient belongs on the backup server. Keep the private
# identity offline/on the operator machine, outside this repository.
set -euo pipefail
umask 077
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required; plaintext backups are disabled}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/asinu}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( RETENTION_DAYS >= 1 )) || { echo 'Invalid backup retention' >&2; exit 1; }
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for dependency in "${POSTGRES_CONTAINER:+docker}" gzip age python3; do
  [ -z "$dependency" ] && dependency=pg_dump
  command -v "$dependency" >/dev/null || { echo "Missing $dependency" >&2; exit 1; }
done
if [ -n "${S3_BUCKET:-}" ]; then command -v aws >/dev/null || { echo 'Upload configured but aws is missing' >&2; exit 1; }; fi
mkdir -p "$BACKUP_DIR"
TMP_BACKUP=$(mktemp "$BACKUP_DIR/.asinu-backup.XXXXXX")
trap 'rm -f "$TMP_BACKUP"' EXIT
printf '' | age -r "$BACKUP_AGE_RECIPIENT" > "$TMP_BACKUP"
OUT="$BACKUP_DIR/asinu-$(date -u +'%Y%m%dT%H%M%SZ')-$(basename "$TMP_BACKUP" | cut -d. -f3).sql.gz.age"
# No plaintext intermediate file or credentials in command arguments/logs.
python3 "$SCRIPT_DIR/pg-command.py" pg_dump --no-owner --no-privileges --format=plain | gzip -9 | age -r "$BACKUP_AGE_RECIPIENT" > "$TMP_BACKUP"
test -s "$TMP_BACKUP"
mv "$TMP_BACKUP" "$OUT"
if [ -n "${S3_BUCKET:-}" ]; then
  AWS_ARGS=(s3 cp "$OUT" "s3://${S3_BUCKET}/asinu/$(basename "$OUT")" --storage-class STANDARD_IA)
  if [ -n "${AWS_S3_ENDPOINT:-}" ]; then AWS_ARGS+=(--endpoint-url "$AWS_S3_ENDPOINT"); fi
  aws "${AWS_ARGS[@]}"
fi
# Retain legacy copies until an encrypted replacement passes a restore test.
find "$BACKUP_DIR" -type f -name 'asinu-*.sql.gz.age' -mtime +"$RETENTION_DAYS" -delete
printf 'Encrypted backup complete: %s\n' "$OUT"
