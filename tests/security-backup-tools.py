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

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class BackupRecovery(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
