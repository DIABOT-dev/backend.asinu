#!/usr/bin/env python3
"""Apply the operator's explicit conclusion-release decision to the active stack."""
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

FLAG = 'CHECKIN_STRUCTURED_CONCLUSION_ENABLED'


def enabled_config(original):
    result = copy.deepcopy(original)
    service = result['services']['asinu-backend']
    environment = service.get('environment', {})
    if isinstance(environment, list):
        environment = [value for value in environment if value.split('=', 1)[0] != FLAG]
        environment.append(FLAG + '=true')
    elif isinstance(environment, dict):
        environment[FLAG] = 'true'
    else:
        raise ValueError('Unsupported environment format')
    service['environment'] = environment
    return result


def env_map(environment):
    return dict(environment) if isinstance(environment, dict) else dict(
        item.split('=', 1) for item in environment if '=' in item)


def inspect():
    value = subprocess.run(['docker', 'inspect', 'asinu-backend'],
                           capture_output=True, check=True, stdin=subprocess.DEVNULL, timeout=15)
    return json.loads(value.stdout)[0]


def atomic_write(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix='.checkin-release-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply_release():
    active = inspect()
    labels = active['Config']['Labels']
    directory = Path(labels['com.docker.compose.project.working_dir']).resolve()
    project = labels['com.docker.compose.project']
    target = directory / 'runtime.compose.json'
    original_bytes = target.read_bytes()
    original = json.loads(original_bytes)
    running_environment = env_map(active['Config']['Env'])
    service = original['services']['asinu-backend']
    if service['image'] != active['Config']['Image']:
        raise RuntimeError('Runtime image drift; no change made')
    for name, value in env_map(service.get('environment', {})).items():
        if name != FLAG and str(value) != running_environment.get(name):
            raise RuntimeError('Runtime environment drift; no change made')
    changed = enabled_config(original)
    history = directory / '.deploy-history'
    history.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = history / (stamp + '.pre-checkin-conclusion.runtime.json')
    atomic_write(backup, original_bytes)
    candidate = directory / ('.checkin-conclusion-' + stamp + '.json')
    atomic_write(candidate, (json.dumps(changed) + '\n').encode())
    command = ['docker', 'compose', '-p', project, '-f', str(target)]

    def compose(arguments, base=command):
        subprocess.run(base + arguments, capture_output=True, check=True,
                       stdin=subprocess.DEVNULL, timeout=120, cwd=directory)

    try:
        compose(['config', '--quiet'], command[:-1] + [str(candidate)])
        atomic_write(target, candidate.read_bytes())
        try:
            compose(['up', '-d', '--no-deps', 'asinu-backend'])
            ready = False
            for _ in range(45):
                try:
                    with urlopen('http://127.0.0.1:3300/api/readyz', timeout=5) as response:
                        ready = response.status == 200
                except Exception:
                    ready = False
                if ready:
                    break
                time.sleep(2)
            after = inspect()
            expected_environment = {**running_environment, FLAG: 'true'}
            if not ready or env_map(after['Config']['Env']) != expected_environment or (
                    after['Config']['Image'] != active['Config']['Image']):
                raise RuntimeError('Conclusion release verification failed')
        except BaseException:
            atomic_write(target, original_bytes)
            compose(['up', '-d', '--no-deps', 'asinu-backend'])
            print('Previous runtime configuration restored.', file=sys.stderr)
            raise
    finally:
        candidate.unlink(missing_ok=True)
    print(json.dumps({'conclusion_enabled': True, 'readyz': 200,
                      'image_unchanged': True, 'other_environment_unchanged': True,
                      'configuration_backup': backup.name}))


if __name__ == '__main__':
    try:
        apply_release()
    except Exception:
        # Subprocess output and configuration can contain private credentials.
        print('Conclusion release failed; inspect the protected runtime backup.', file=sys.stderr)
        sys.exit(1)
