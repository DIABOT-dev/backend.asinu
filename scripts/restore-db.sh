#!/usr/bin/env bash
#
# Restore from a backup produced by backup-db.sh.
#
# Usage:
#   ./scripts/restore-db.sh <path-to-backup.sql.gz>
#
# Requires DATABASE_URL pointing at the TARGET database (NOT production!).

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <backup.sql.gz>" >&2
  exit 1
fi

SRC="$1"
if [ ! -f "$SRC" ]; then
  echo "Backup file not found: $SRC" >&2
  exit 1
fi

echo "About to restore $SRC into $DATABASE_URL"
read -r -p "Type 'yes' to continue: " confirm
[ "$confirm" = "yes" ] || { echo "Aborted."; exit 1; }

gunzip -c "$SRC" | psql "$DATABASE_URL"
echo "Restore complete."
