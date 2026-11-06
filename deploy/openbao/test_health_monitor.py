import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).with_name('health-monitor.py'))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class MonitorTests(unittest.TestCase):
    def test_incident_deduplication_recovery_and_delivery_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {'state_file': str(Path(directory) / 'state.json'), 'sentry_dsn': 'fixture',
                      'checks': [{'name': 'openbao', 'type': 'openbao'}]}
            calls = []
            now = [2_000_000]
            status = ['OPENBAO_SEALED']
            def deliver(*args):
                calls.append(args)
                return 'synthetic-event-id'
            run = lambda transport=deliver: monitor.run(config, lambda: now[0], lambda *_: status[0], transport)
            self.assertFalse(run()['healthy'])
            now[0] += 60
            run()
            self.assertEqual(len(calls), 1)
            status[0] = None
            self.assertTrue(run()['healthy'])
            self.assertTrue(calls[-1][-1])
            status[0] = 'OPENBAO_SEALED'
            def fail(*_): raise RuntimeError('synthetic transport failure')
            self.assertTrue(run(fail)['delivery_failed'])
            now[0] += 60
            run()
            self.assertEqual(len(calls), 3)

    def test_backup_freshness_checks_ciphertext_magic_and_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            check = {'type': 'backup', 'directory': directory, 'pattern': '*.age', 'max_age_seconds': 3600}
            self.assertEqual(monitor.check_health(check), 'BACKUP_STALE')
            file = Path(directory) / 'fixture.age'
            file.write_text('plaintext mislabeled as ciphertext')
            self.assertEqual(monitor.check_health(check), 'BACKUP_INVALID')
            file.write_bytes(b'age-encryption.org/v1\nsynthetic')
            self.assertIsNone(monitor.check_health(check))
