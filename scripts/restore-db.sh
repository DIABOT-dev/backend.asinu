#!/usr/bin/env bash
# Run on the recovery host holding the private age identity, not on the VPS.
# RESTORE_TMP_DIR should be a private tmpfs for plaintext restore staging.
set -euo pipefail
umask 077
: "${DATABASE_URL:?DATABASE_URL must point to the recovery target}"
: "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required}"
: "${RESTORE_TARGET_DATABASE:?Set RESTORE_TARGET_DATABASE to the exact recovery database name}"
[[ $# == 1 && -f "$1" && "$1" == *.sql.gz.age ]] || { echo "Usage: $0 <backup.sql.gz.age>" >&2; exit 1; }
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for dependency in psql gzip age python3; do command -v "$dependency" >/dev/null || { echo "Missing $dependency" >&2; exit 1; }; done
[[ -r "$BACKUP_AGE_IDENTITY" ]] || { echo 'Identity is unreadable' >&2; exit 1; }

TARGET=$(python3 "$SCRIPT_DIR/pg-command.py" psql -XAt -v ON_ERROR_STOP=1 -c 'SELECT current_database()')
[[ "$TARGET" == "$RESTORE_TARGET_DATABASE" ]] || { echo 'Recovery target mismatch' >&2; exit 1; }
TABLES=$(python3 "$SCRIPT_DIR/pg-command.py" psql -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
[[ "$TABLES" == 0 ]] || { echo 'Refusing restore into a nonempty database; create an isolated empty recovery database' >&2; exit 1; }
WORK_DIR=$(mktemp -d "${RESTORE_TMP_DIR:-${TMPDIR:-/tmp}}/asinu-restore.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
# Validate the entire encrypted/compressed stream before the SQL transaction.
# A failed decrypt pipeline must never commit a partially restored database.
age -d -i "$BACKUP_AGE_IDENTITY" "$1" | gzip -d > "$WORK_DIR/restore.sql"
test -s "$WORK_DIR/restore.sql"
python3 "$SCRIPT_DIR/pg-command.py" psql -X -v ON_ERROR_STOP=1 --single-transaction -f "$WORK_DIR/restore.sql" >/dev/null
printf 'Restore verified into %s\n' "$TARGET"
