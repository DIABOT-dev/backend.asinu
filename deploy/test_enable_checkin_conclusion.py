import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('enable-checkin-conclusion.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ConclusionReleaseTests(unittest.TestCase):
    def fixture(self, failure=''):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = {'PRIVATE_SECRET': 'fixture-never-print', release.FLAG: 'false',
                           'KEY_MANAGEMENT_PROVIDER': 'openbao', 'CHECKIN_DETAILED_QUESTIONS_ENABLED': 'false'}
            original = {'services': {'asinu-backend': {'image': 'verified:existing',
                        'environment': environment, 'volumes': ['/private/keys:/run/keys:ro']},
                        'other-service': {'image': 'untouched'}}}
            target = root / 'runtime.compose.json'
            original_bytes = json.dumps(original).encode()
            target.write_bytes(original_bytes)
            before = {'Config': {'Image': 'verified:existing', 'Env': [f'{k}={v}' for k, v in environment.items()],
                      'Labels': {'com.docker.compose.project': 'existing',
                                 'com.docker.compose.project.working_dir': directory}}}
            after = copy.deepcopy(before)
            after['Config']['Env'] = [f'{k}={v}' for k, v in {**environment, release.FLAG: 'true'}.items()]
            if failure == 'environment':
                after['Config']['Env'].append('UNEXPECTED_CHANGE=true')
            if failure == 'drift':
                before['Config']['Image'] = 'unexpected:image'
            calls = []

            def run(command, **kwargs):
                self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
                self.assertTrue(kwargs['capture_output'])
                calls.append(command)
                if failure == 'compose' and 'up' in command and sum('up' in c for c in calls) == 1:
                    raise subprocess.CalledProcessError(1, command)

            response = type('Response', (), {'__enter__': lambda s: s, '__exit__': lambda *args: None, 'status': 200})()
            with patch.object(release, 'inspect', side_effect=[before, after]), patch.object(release.subprocess, 'run', side_effect=run), \
                    patch.object(release, 'urlopen', return_value=response), patch('sys.stdout', new_callable=io.StringIO) as output, \
                    patch('sys.stderr', new_callable=io.StringIO) as errors:
                if failure:
                    with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                        release.apply_release()
                    self.assertEqual(target.read_bytes(), original_bytes)
                else:
                    release.apply_release()
                    expected = copy.deepcopy(original)
                    expected['services']['asinu-backend']['environment'][release.FLAG] = 'true'
                    self.assertEqual(json.loads(target.read_text()), expected)
                    self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                    backups = list((root / '.deploy-history').glob('*runtime.json'))
                    self.assertEqual(backups[0].read_bytes(), original_bytes)
                self.assertNotIn('fixture-never-print', output.getvalue() + errors.getvalue())
            for command in calls:
                if 'up' in command:
                    self.assertEqual(command[-4:], ['up', '-d', '--no-deps', 'asinu-backend'])
                self.assertNotIn('--remove-orphans', command)
            self.assertFalse(list(root.glob('.checkin-conclusion-*')))
            return calls

    def test_enable_changes_only_the_conclusion_flag(self):
        self.fixture()

    def test_start_failure_restores_configuration_and_service(self):
        calls = self.fixture('compose')
        self.assertEqual(sum('up' in call for call in calls), 2)

    def test_unexpected_environment_change_rolls_back(self):
        self.fixture('environment')

    def test_image_drift_stops_before_mutation(self):
        self.assertEqual(self.fixture('drift'), [])

    def test_list_environment_keeps_private_values_and_other_services(self):
        original = {'services': {'asinu-backend': {'environment': ['PRIVATE=a=b', release.FLAG + '=false']},
                                'doctor': {'image': 'preserved'}}}
        result = release.enabled_config(original)
        self.assertEqual(result['services']['asinu-backend']['environment'], ['PRIVATE=a=b', release.FLAG + '=true'])
        self.assertEqual(original['services']['asinu-backend']['environment'][-1], release.FLAG + '=false')
        self.assertEqual(result['services']['doctor'], original['services']['doctor'])


if __name__ == '__main__':
    unittest.main()
