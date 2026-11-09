#!/usr/bin/env bash
set -euo pipefail
cd "$STACK_DIR"
previous_image="$(docker inspect --format '{{.Config.Image}}' asinu-backend)"
active_dir="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' asinu-backend)"
project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' asinu-backend)"
if [ "$(realpath "$STACK_DIR")" != "$(realpath "$active_dir")" ]; then
  echo 'Deployment directory does not match the running backend; no runtime change made.' >&2
  exit 1
fi
test -n "$project"
umask 077
mkdir -p .deploy-history
release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
printf 'previous_image=%s\ntarget_image=%s\n' "$previous_image" "$ASINU_BACKEND_IMAGE" > ".deploy-history/${release_stamp}.images"
if [ "$DEPLOY_ENV" = 'prod' ]; then
  echo 'Starting encrypted production backup.'
  systemctl start asinu-encrypted-backup.service
  test "$(systemctl show asinu-encrypted-backup.service -p Result --value)" = 'success'
  echo 'Encrypted production backup completed before migration.'
fi
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
export ASINU_BACKEND_IMAGE HOST_PORT
json_mode=0
runtime_override=".deploy-history/${release_stamp}.runtime.image.json"
migration_override=".deploy-history/${release_stamp}.migration.image.json"
if [ -f runtime.compose.json ]; then
  json_mode=1
  echo 'Using the existing private Compose JSON configuration.'
  if [ ! -f migration.compose.json ]; then
    directory64="$(printf '%s' "$STACK_DIR" | base64 -w0)"
    python3 .deploy-tools/prepare-auto-deploy.py "$directory64"
  fi
  for file in runtime.compose.json migration.compose.json; do
    test -f "$file"
    cp -p "$file" ".deploy-history/pre-${release_stamp}-${file}"
  done
  printf '{"services":{"asinu-backend":{"image":"%s"}}}\n' "$ASINU_BACKEND_IMAGE" > "$runtime_override"
  printf '{"services":{"asinu-migrate":{"image":"%s"}}}\n' "$ASINU_BACKEND_IMAGE" > "$migration_override"
  runtime_compose=(docker compose -p "$project" -f runtime.compose.json -f "$runtime_override")
  migration_compose=(docker compose -p "$project" -f migration.compose.json -f "$migration_override")
else
  test -f .env
  test -f .env.migrations
  runtime_compose=(docker compose -p "$project" -f docker-compose.yml)
  if grep -q '^KEY_MANAGEMENT_PROVIDER=openbao$' .env; then
    runtime_compose+=(-f docker-compose.openbao.yml)
  fi
  migration_compose=("${runtime_compose[@]}" --profile migration)
fi
"${runtime_compose[@]}" config --quiet
"${migration_compose[@]}" config --quiet
"${runtime_compose[@]}" pull asinu-backend
"${migration_compose[@]}" pull asinu-migrate
"${migration_compose[@]}" run --rm --no-deps asinu-migrate </dev/null
"${runtime_compose[@]}" up -d --no-deps asinu-backend
healthy=0
for _ in $(seq 1 45); do
  if curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${HOST_PORT}/api/readyz" >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -eq 1 ]; then
  if ! docker exec asinu-backend node -e '
    const { createPool } = require("./src/lib/db");
    const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 1 });
    (async () => {
      try {
        const { rows } = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present, has_table_privilege(current_user,$1,$2) AS can_read, has_table_privilege(current_user,$1,$3) AS can_insert", ["public.health_checkin_cancellations", "SELECT", "INSERT"]);
        console.log(JSON.stringify({ cancellation_schema: rows[0] }));
        if (!rows[0].present || !rows[0].can_read || !rows[0].can_insert) throw new Error("Cancellation schema is not ready");
      } finally { await pool.end(); }
    })().catch(() => { console.error("Cancellation schema verification failed"); process.exitCode = 1; });
  '; then
    healthy=0
  fi
fi
if [ "$healthy" -ne 1 ]; then
  docker inspect asinu-backend --format 'Backend status={{.State.Status}}'
  if [ "$json_mode" -eq 1 ]; then
    printf '{"services":{"asinu-backend":{"image":"%s"}}}\n' "$previous_image" > "$runtime_override"
  else
    export ASINU_BACKEND_IMAGE="$previous_image"
  fi
  "${runtime_compose[@]}" up -d --no-deps asinu-backend
  echo 'Previous backend image restored.' >&2
  exit 1
fi
if [ "$json_mode" -eq 1 ]; then
  # Persist only the verified image pin, preserving credentials, mounts and flags.
  python3 - <<'PYIMAGE'
import json, os, tempfile
from pathlib import Path
for filename, service in [('runtime.compose.json','asinu-backend'),('migration.compose.json','asinu-migrate')]:
    target=Path(filename)
    config=json.loads(target.read_text())
    config['services'][service]['image']=os.environ['ASINU_BACKEND_IMAGE']
    descriptor, temporary=tempfile.mkstemp(prefix='.verified-image-',dir='.')
    try:
        with os.fdopen(descriptor,'w') as output:
            json.dump(config,output);output.write('\n');output.flush();os.fsync(output.fileno())
        os.chmod(temporary,0o600)
        os.replace(temporary,target)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)
PYIMAGE
fi
printf 'Verified backend image: %s\n' "$ASINU_BACKEND_IMAGE"
