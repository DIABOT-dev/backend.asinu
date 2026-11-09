import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, unquote

spec = importlib.util.spec_from_file_location("prepare_auto_deploy", Path(__file__).with_name("prepare-auto-deploy.py"))
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)


def runtime_config():
    return {"services": {"asinu-backend": {
        "image": "asinu-backend:existing", "container_name": "asinu-backend",
        "ports": ["3300:3000"], "restart": "unless-stopped",
        "environment": {"DATABASE_URL": "postgresql://asinu_runtime:runtime-password@db.internal:5432/asinu?sslmode=verify-full", "DB_TLS_REQUIRE": "true"},
        "volumes": ["/private/ca.pem:/run/asinu-db-tls/ca.pem:ro"],
    }}, "networks": {"asinu_net": {"external": True}}}


class PreparationTests(unittest.TestCase):
    def test_privileged_credentials_are_limited_to_migration_service(self):
        runtime = runtime_config()
        original = copy.deepcopy(runtime)
        result = preparation.migration_config(runtime, {"POSTGRES_USER": "migration_admin", "POSTGRES_PASSWORD": "private $&/password"})
        self.assertEqual(runtime, original)
        self.assertEqual(list(result["services"]), ["asinu-migrate"])
        service = result["services"]["asinu-migrate"]
        database = urlsplit(service["environment"]["DATABASE_URL"])
        self.assertEqual((database.hostname, database.port, database.path, database.query), ("db.internal", 5432, "/asinu", "sslmode=verify-full"))
        self.assertEqual(unquote(database.username), "migration_admin")
        self.assertEqual(unquote(database.password), "private $&/password")
        self.assertNotIn("ports", service)
        self.assertNotIn("container_name", service)
        self.assertEqual(service["volumes"], original["services"]["asinu-backend"]["volumes"])
        self.assertEqual(service["command"][-1], "scripts/migrate.js")

    def test_list_environment_and_ipv6_are_preserved(self):
        runtime = runtime_config()
        runtime["services"]["asinu-backend"]["environment"] = ["DATABASE_URL=postgresql://runtime:p@[::1]:5432/asinu", "DB_TLS_REQUIRE=true"]
        result = preparation.migration_config(runtime, {"POSTGRES_PASSWORD": "secret"})
        database = urlsplit(result["services"]["asinu-migrate"]["environment"]["DATABASE_URL"])
        self.assertEqual((database.username, database.hostname, database.port), ("postgres", "::1", 5432))

    def test_failed_connection_removes_only_new_file_and_preserves_api(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            runtime = runtime_config()
            runtime_file = path / "runtime.compose.json"
            runtime_file.write_text(json.dumps(runtime))
            containers = {
                "asinu-backend": {"Config": {"Image": "asinu-backend:existing", "Labels": {"com.docker.compose.project.working_dir": directory, "com.docker.compose.project": "active-project"}}},
                "asinu_postgres": {"Config": {"Env": ["POSTGRES_USER=admin", "POSTGRES_PASSWORD=private"]}},
            }
            with patch.object(preparation, "inspect_container", side_effect=lambda name: containers[name]), patch.object(preparation.subprocess, "run", side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=1)]) as run:
                with self.assertRaises(RuntimeError):
                    preparation.prepare(directory)
                self.assertFalse((path / "migration.compose.json").exists())
                self.assertEqual(json.loads(runtime_file.read_text()), runtime)
                commands = [call.args[0] for call in run.call_args_list]
                self.assertFalse(any("up" in command for command in commands))
                self.assertNotIn("scripts/migrate.js", commands[-1])

    def test_cannot_prepare_a_directory_other_than_the_active_stack(self):
        container = {"Config": {"Labels": {"com.docker.compose.project.working_dir": "/actual-production"}}}
        with patch.object(preparation, "inspect_container", return_value=container):
            with self.assertRaisesRegex(RuntimeError, "running production stack"):
                preparation.prepare("/other-directory")


if __name__ == "__main__":
    unittest.main()
