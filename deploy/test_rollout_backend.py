import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('rollout-backend.sh').resolve()


class RolloutTests(unittest.TestCase):
    def run_fixture(self, json_mode=True, failure=''):
        with tempfile.TemporaryDirectory(prefix='asinu-rollout-') as directory:
            root = Path(directory)
            commands = root / 'bin'
            commands.mkdir()
            trace = root / 'trace'
            mock = '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['TEST_TRACE'],'a') as log:log.write(json.dumps([name]+args)+'\\n')
if name=='docker' and args[0]=='inspect':
    expression=args[args.index('--format')+1]
    print(os.environ['STACK_DIR'] if 'working_dir' in expression else 'fixture-project' if 'project' in expression else 'old-image:verified')
if name=='systemctl':
    if args[0]=='start' and os.environ['TEST_FAILURE']=='backup':sys.exit(1)
    if args[0]=='show':print('success')
if name=='docker' and args[0]=='exec' and os.environ['TEST_FAILURE']=='schema':sys.exit(1)
if name=='seq':print(1)
'''
            for name in ['docker', 'systemctl', 'curl', 'seq', 'sleep']:
                path = commands / name
                path.write_text(mock)
                path.chmod(0o700)
            original = {'services': {'asinu-backend': {
                'image': 'old-image:verified',
                'environment': {'PRIVATE_FIXTURE': 'never-log-this-value'},
                'volumes': ['/existing-keyring:/run/keys']}}}
            if json_mode:
                (root / 'runtime.compose.json').write_text(json.dumps(original))
                (root / 'migration.compose.json').write_text(json.dumps({'services': {'asinu-migrate': original['services']['asinu-backend']}}))
            else:
                (root / '.env').write_text('KEY_MANAGEMENT_PROVIDER=openbao\nPRIVATE_FIXTURE=never-log-this-value\n')
                (root / '.env.migrations').write_text('PRIVATE_FIXTURE=never-log-this-value\n')
            result = subprocess.run(['bash', str(SCRIPT)], cwd=root, env={
                **os.environ, 'PATH': str(commands) + os.pathsep + os.environ['PATH'],
                'STACK_DIR': str(root), 'ASINU_BACKEND_IMAGE': 'new-image:verified',
                'GHCR_USER': 'fixture', 'GHCR_TOKEN': 'fixture-token', 'HOST_PORT': '3300',
                'DEPLOY_ENV': 'prod', 'TEST_TRACE': str(trace), 'TEST_FAILURE': failure,
            }, capture_output=True, text=True, timeout=20)
            calls = [json.loads(line) for line in trace.read_text().splitlines()]
            runtime = json.loads((root / 'runtime.compose.json').read_text()) if json_mode else None
            overrides = [json.loads(path.read_text()) for path in (root / '.deploy-history').glob('*.runtime.image.json')]
            self.assertNotIn('never-log-this-value', result.stdout + result.stderr)
            self.assertTrue(all('--remove-orphans' not in call for call in calls))
            return result, calls, runtime, overrides

    def test_json_preserves_existing_environment_and_mounts(self):
        result, calls, runtime, _ = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)
        service = runtime['services']['asinu-backend']
        self.assertEqual(service['image'], 'new-image:verified')
        self.assertEqual(service['environment']['PRIVATE_FIXTURE'], 'never-log-this-value')
        self.assertEqual(service['volumes'], ['/existing-keyring:/run/keys'])
        backup = next(i for i, call in enumerate(calls) if call[:2] == ['systemctl', 'start'])
        migration = next(i for i, call in enumerate(calls) if 'run' in call and 'asinu-migrate' in call)
        self.assertLess(backup, migration)

    def test_env_stack_keeps_openbao_overlay(self):
        result, calls, _, _ = self.run_fixture(json_mode=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        up = [call for call in calls if 'up' in call]
        self.assertEqual(len(up), 1)
        self.assertIn('docker-compose.openbao.yml', up[0])

    def test_failed_backup_stops_before_migration_or_replacement(self):
        result, calls, runtime, _ = self.run_fixture(failure='backup')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('run' in call or 'up' in call for call in calls))
        self.assertEqual(runtime['services']['asinu-backend']['image'], 'old-image:verified')

    def test_failed_schema_check_restores_previous_image(self):
        result, calls, runtime, overrides = self.run_fixture(failure='schema')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len([call for call in calls if 'up' in call]), 2)
        self.assertEqual(runtime['services']['asinu-backend']['image'], 'old-image:verified')
        self.assertEqual(overrides[0]['services']['asinu-backend']['image'], 'old-image:verified')


if __name__ == '__main__':
    unittest.main()
