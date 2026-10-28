"""Exercise real age recovery and reject tampered/unsafe recovery material."""
import contextlib
import gzip
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class BackupRecovery(unittest.TestCase):
    def test_openbao_wrapped_user_keys_and_keyring_metadata_survive_backup(self):
        backup = module('backup-health-keys')
        pull = module('pull-encrypted-backups')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = root / 'identity'
            subprocess.run(['age-keygen', '-o', str(identity)], check=True, capture_output=True)
            recipient = subprocess.check_output(['age-keygen', '-y', str(identity)], text=True).strip()
            keys = root / 'keys'; keys.mkdir(mode=0o700)
            opaque = b'asinu:key:v2:' + b'A' * 80
            key = keys / '42.key'; key.write_bytes(opaque); key.chmod(0o600)
            keyrings = root / 'openbao'; (keyrings / 'asinu-backend').mkdir(parents=True)
            import json
            wrapped = keyrings / 'asinu-backend/wrapped-keys.json'
            wrapped.write_text(json.dumps({'version': 1, 'role': 'asinu-backend',
                'transit_key': 'asinu-health', 'entries': [{'id': 'health-key-wrap', 'ciphertext': 'vault:v1:AA=='}]}))
            wrapped.chmod(0o600)
            crm = keyrings / 'crm-backend/wrapped-keys.json'
            crm.parent.mkdir()
            crm.write_text(json.dumps({'version': 1, 'role': 'crm-backend',
                'transit_key': 'asinu-crm', 'entries': [{'id': 'crm-pii', 'ciphertext': 'vault:v1:AA=='}]}))
            crm.chmod(0o600)
            with patch.dict(os.environ, {'OPENBAO_KEYRING_HOST_DIRECTORY': str(keyrings)}):
                with contextlib.redirect_stdout(io.StringIO()):
                    archive = backup.backup_keys(keys, root, recipient, root / 'absent-volume')
            pull.validate_backup(archive, str(identity), True)
            decrypted = subprocess.check_output(['age', '-d', '-i', str(identity), str(archive)])
            with tarfile.open(fileobj=io.BytesIO(decrypted)) as recovered:
                self.assertEqual(recovered.extractfile('users/42.key').read(), opaque)
                self.assertEqual(recovered.extractfile('openbao/asinu-backend.json').read(), wrapped.read_bytes())
                self.assertEqual(recovered.extractfile('openbao/crm-backend.json').read(), crm.read_bytes())

    def test_recovery_and_tamper_detection(self):
        backup = module('backup-health-keys')
        pull = module('pull-encrypted-backups')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            os.chmod(root, 0o700)
            identity = root / 'identity'
            subprocess.run(['age-keygen', '-o', str(identity)], check=True, capture_output=True)
            recipient = subprocess.check_output(['age-keygen', '-y', str(identity)], text=True).strip()
            keys = root / 'keys'; keys.mkdir(mode=0o700)
            key = keys / '42.key'; key.write_bytes(os.urandom(32)); key.chmod(0o600)
            with contextlib.redirect_stdout(io.StringIO()):
                archive = backup.backup_keys(keys, root, recipient, root / 'absent-volume')
            pull.validate_backup(archive, str(identity), True)
            decrypted = subprocess.check_output(['age', '-d', '-i', str(identity), str(archive)])
            with tarfile.open(fileobj=io.BytesIO(decrypted)) as recovered:
                self.assertEqual(recovered.extractfile('users/42.key').read(), key.read_bytes())
            sql = root / 'fixture.sql.gz.age'
            sql.write_bytes(subprocess.check_output(['age', '-r', recipient], input=gzip.compress(b'SELECT 1;')))
            pull.validate_backup(sql, str(identity))
            damaged = bytearray(sql.read_bytes()); damaged[-1] ^= 1; sql.write_bytes(damaged)
            with self.assertRaises(RuntimeError):
                pull.validate_backup(sql, str(identity))
            key.chmod(0o644)
            with self.assertRaises(RuntimeError):
                backup.backup_keys(keys, root, recipient, root / 'absent-volume')
            self.assertFalse(list(root.glob('.asinu-keys-*')))

    def test_retention_keeps_recovery_copies_for_each_database(self):
        pull = module('pull-encrypted-backups')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for label in ['main', 'doctor']:
                for day in range(1, 5):
                    (root / f'asinu-2020010{day}T000000Z-{label}-fixture.sql.gz.age').touch()
            pull.prune_backups(root, 14)
            self.assertEqual(len(list(root.glob('*-main-*'))), 2)
            self.assertEqual(len(list(root.glob('*-doctor-*'))), 2)

    def test_success_requires_fresh_sql_and_key_archives(self):
        pull = module('pull-encrypted-backups')
        now = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        files = [f'asinu-{now}-main-fixture.sql.gz.age', f'asinu-{now}-doctor-fixture.sql.gz.age', f'asinu-{now}-fixture.keys.tar.age']
        pull.require_fresh_recovery_sets(files)
        with self.assertRaises(RuntimeError):
            pull.require_fresh_recovery_sets(files[:-1])
        with self.assertRaises(RuntimeError):
            pull.require_fresh_recovery_sets([name.replace(now, '20200101T000000Z') for name in files])

    def test_legacy_retention_cannot_delete_outside_private_recovery_root(self):
        pull = module('pull-encrypted-backups')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            private = root / 'private'; private.mkdir()
            legacy = private / 'legacy'; legacy.mkdir()
            identity = private / 'identity'
            subprocess.run(['age-keygen', '-o', str(identity)], check=True, capture_output=True)
            recipient = subprocess.check_output(['age-keygen', '-y', str(identity)], text=True).strip()
            encrypted = subprocess.check_output(['age', '-r', recipient], input=b'legacy fixture')
            stale = legacy / 'old.age'; stale.write_bytes(encrypted); os.utime(stale, (1, 1))
            current = legacy / 'current.age'; current.write_bytes(encrypted)
            pull.prune_legacy_copies({'age_identity': str(identity), 'legacy_directories': [str(legacy)]})
            self.assertFalse(stale.exists()); self.assertTrue(current.exists())
            outside = root / 'outside'; outside.mkdir()
            other = outside / 'other.age'; other.write_bytes(encrypted); os.utime(other, (1, 1))
            with self.assertRaises(RuntimeError):
                pull.prune_legacy_copies({'age_identity': str(identity), 'legacy_directories': [str(outside)]})
            self.assertTrue(other.exists())


if __name__ == '__main__':
    unittest.main()
