import datetime
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).resolve().parents[1] / 'scripts/pull-crm-backup.py')
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.destination = Path(self.temporary.name)
        self.body = b'age-encryption.org/v1\n' + b'ciphertext-fixture-only' * 20
        self.now = datetime.datetime.now(datetime.timezone.utc).timestamp()
        self.stamp = self.now - 3600
        self.metadata = {'file': 'crm-20261102T000000Z-abcdef.dump.age', 'encrypted_bytes': len(self.body),
                         'sha256': hashlib.sha256(self.body).hexdigest(),
                         'last_success_at': datetime.datetime.fromtimestamp(self.stamp, datetime.timezone.utc).isoformat()}

    def receive(self, body=None):
        stream = io.BytesIO((json.dumps(self.metadata) + '\n').encode() + (self.body if body is None else body))
        return receiver.receive(stream, self.destination, now=self.now)

    def test_receive_preserves_creation_time_for_freshness_monitor(self):
        self.receive()
        target = self.destination / self.metadata['file']
        self.assertEqual(target.read_bytes(), self.body)
        self.assertAlmostEqual(target.stat().st_mtime, self.stamp, places=3)
        self.assertEqual(target.stat().st_mode & 0o077, 0)

    def test_truncated_corrupt_plaintext_and_extra_streams_are_rejected(self):
        for body in [self.body[:-1], self.body[:-1] + b'x', b'p' * len(self.body), self.body + b'extra']:
            with self.subTest(body_size=len(body)), self.assertRaises(RuntimeError):
                self.receive(body)
            self.assertEqual(list(self.destination.iterdir()), [])

    def test_path_traversal_oversized_stale_and_future_metadata_are_rejected(self):
        for field, value in [('file', '../leak.age'), ('encrypted_bytes', 2 ** 32),
                             ('last_success_at', '2000-01-01T00:00:00+00:00'),
                             ('last_success_at', '2099-01-01T00:00:00+00:00')]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                original = self.metadata[field]
                self.metadata[field] = value
                try:
                    self.receive()
                finally:
                    self.metadata[field] = original
            self.assertEqual(list(self.destination.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
