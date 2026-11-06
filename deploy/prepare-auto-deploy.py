#!/usr/bin/env python3
"""Prepare a private migration Compose file from the running production stack.

Credentials stay on the VPS. This performs only a read-only database connection
check; it does not execute migrations or replace the running API container.
"""
import base64
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote, urlsplit, urlunsplit


def inspect_container(name):
    result = subprocess.run(["docker", "inspect", name], capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("Required production container is unavailable")
    return json.loads(result.stdout)[0]


def environment_of(values):
    if isinstance(values, dict):
        return dict(values)
    return dict(value.split("=", 1) for value in values if "=" in value)


def migration_config(runtime, postgres_environment):
    config = copy.deepcopy(runtime)
    service = config["services"]["asinu-backend"]
    environment = environment_of(service.get("environment", {}))
    database = urlsplit(environment["DATABASE_URL"])
    username = postgres_environment.get("POSTGRES_USER", "postgres")
    password = postgres_environment["POSTGRES_PASSWORD"]
    if database.scheme not in ("postgres", "postgresql") or not database.hostname:
        raise RuntimeError("Runtime database configuration is invalid")
    host = database.hostname
    if ":" in host:
        host = "[" + host + "]"
    netloc = quote(username, safe="") + ":" + quote(password, safe="") + "@" + host
    if database.port:
        netloc += ":" + str(database.port)
    environment["DATABASE_URL"] = urlunsplit(database._replace(netloc=netloc))
    service["environment"] = environment
    service["command"] = ["node", "src/security/start-with-keyring.cjs", "scripts/migrate.js"]
    service["restart"] = "no"
    service["healthcheck"] = {"disable": True}
    for field in ("container_name", "ports", "depends_on", "profiles", "build"):
        service.pop(field, None)
    config["services"] = {"asinu-migrate": service}
    return config


def prepare(directory):
    active = inspect_container("asinu-backend")
    labels = active["Config"].get("Labels") or {}
    active_directory = Path(labels["com.docker.compose.project.working_dir"]).resolve()
    directory = Path(directory).resolve()
    if directory != active_directory:
        raise RuntimeError("Deployment directory must match the running production stack")
    runtime_file = directory / "runtime.compose.json"
    migration_file = directory / "migration.compose.json"
    runtime = json.loads(runtime_file.read_text())
    created = False
    if not migration_file.exists():
        postgres = inspect_container("asinu_postgres")
        config = migration_config(runtime, environment_of(postgres["Config"]["Env"]))
        # Run the preflight with the image already in use, without any registry build.
        config["services"]["asinu-migrate"]["image"] = active["Config"]["Image"]
        fd = os.open(migration_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(config, output)
            output.write("\n")
        created = True
    project = labels["com.docker.compose.project"]
    command = ["docker", "compose", "-p", project, "-f", str(migration_file)]
    # The existing verified-TLS helper and privileged migration role are checked
    # without reading patient data or running any DDL.
    check_script = """
const {Client}=require('pg');
const {databaseOptions}=require('./src/lib/database-options');
const client=new Client(databaseOptions(process.env.DATABASE_URL));
(async()=>{try{await client.connect();
const result=await client.query('SELECT usesuper FROM pg_user WHERE usename=current_user');
if(!result.rows[0]?.usesuper) throw new Error('Migration role needs review');
process.stdout.write('Migration connection verified\\n');
}catch{process.exitCode=1;}finally{await client.end();}})();
"""
    try:
        checks = [
            ("Verifying migration Compose configuration.", ["config", "--quiet"]),
            ("Verifying read-only database access.", ["run", "--rm", "--no-deps", "asinu-migrate", "node", "-e", check_script]),
        ]
        for message, arguments in checks:
            print(message, flush=True)
            result = subprocess.run(command + arguments, capture_output=True, check=False, timeout=90)
            if result.returncode:
                raise RuntimeError("Migration configuration or database connection verification failed")
    except BaseException:
        if created:
            migration_file.unlink()
        raise
    print("Production runtime and separate migration configuration are ready.")
    print("Migration database connection verified; no migrations were executed.")


if __name__ == "__main__":
    try:
        prepare(base64.b64decode(sys.argv[1], validate=True).decode())
    except Exception:
        # Never include environment objects, database URLs, or subprocess output.
        print("Production configuration preparation failed; existing API was preserved.", file=sys.stderr)
        sys.exit(1)
