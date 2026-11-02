import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

path = Path(__file__).resolve().parents[2] / 'scripts' / 'retire-plaintext-backup.py'
spec = importlib.util.spec_from_file_location('legacy', path)
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


@unittest.skipUnless(shutil.which('age'), 'age CLI required')
class LegacyRetirementTests(unittest.TestCase):
    def test_original_survives_until_verified_and_replacement_is_recoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = root / 'identity'
            subprocess.run(['age-keygen', '-o', str(identity)], capture_output=True, check=True)
            recipient = subprocess.check_output(['age-keygen', '-y', str(identity)], text=True).strip()
            source = root / 'synthetic-backup'
            source.write_bytes(b'synthetic private configuration')
            receipt = legacy.encrypt(source, root / 'encrypted', recipient)
            with self.assertRaises(RuntimeError):
                legacy.retire(receipt)
            self.assertTrue(source.exists())
            recovered = subprocess.check_output(['age', '-d', '-i', str(identity), receipt['encrypted']])
            self.assertEqual(recovered, source.read_bytes())
            receipt['offhost_verified'] = True
            self.assertTrue(legacy.retire(receipt)['original_removed'])
            self.assertFalse(source.exists())

    def test_modified_original_is_not_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = root / 'identity'
            subprocess.run(['age-keygen', '-o', str(identity)], capture_output=True, check=True)
            recipient = subprocess.check_output(['age-keygen', '-y', str(identity)], text=True).strip()
            source = root / 'synthetic-backup'
            source.write_bytes(b'original synthetic data')
            receipt = legacy.encrypt(source, root / 'encrypted', recipient)
            receipt['offhost_verified'] = True
            source.write_bytes(b'new synthetic data that was not backed up')
            with self.assertRaises(RuntimeError):
                legacy.retire(receipt)
            self.assertTrue(source.exists())
