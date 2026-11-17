#!/usr/bin/env python3
"""Switch only the ASINU backend, preserving a protected rollback configuration."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile


def atomic_write(path, contents):
    fd, temporary = tempfile.mkstemp(prefix='.ninerouter-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def switch(compose, key_file, image, project, model):
    compose = compose.resolve()
    if key_file.stat().st_mode & 0o077:
        raise RuntimeError('API key file must be private to its owner')
    key = key_file.read_text().strip()
    if not key or '\n' in key:
        raise RuntimeError('API key file is invalid')
    subprocess.run(['docker', 'image', 'inspect', image], check=True, stdout=subprocess.DEVNULL)
    original = compose.read_bytes()
    document = json.loads(original)
    service = document['services']['asinu-backend']
    environment = service['environment']
    if not isinstance(environment, dict):
        raise RuntimeError('Expected a Compose environment mapping')
    environment.update({
        'AI_PROVIDER_CLINICAL': '9router',
        'SYMPTOM_AI_PROVIDER': '9router',
        'SYMPTOM_AI_MODEL': model,
        'DOCTOR_AI_PROVIDER': '9router',
        'DOCTOR_AI_CHAT_MODEL': model,
        'NINEROUTER_ENDPOINT': 'https://9router.asinu.top/v1/chat/completions',
        'NINEROUTER_API_KEY': key,
        'NINEROUTER_MODEL': model,
        'NINEROUTER_VISION_MODEL': model,
        'NINEROUTER_SUPPORTS_JSON_MODE': 'false',
        'ASINU_BACKEND_IMAGE': image,
    })
    for name in ('MEDGEMMA_ENDPOINT', 'MEDGEMMA_API_KEY', 'MEDGEMMA_MODEL'):
        environment.pop(name, None)
    service['image'] = image
    history = compose.parent / '.deploy-history'
    history.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = history / ('before-ninerouter-' + stamp + '.json')
    atomic_write(backup, original)
    staged = compose.parent / ('.ninerouter-staged-' + stamp + '.json')
    atomic_write(staged, (json.dumps(document, indent=2) + '\n').encode())
    command = ['docker', 'compose', '-p', project, '-f', str(compose),
               'up', '-d', '--no-build', '--no-deps', '--force-recreate',
               '--wait', '--wait-timeout', '90', 'asinu-backend']
    try:
        subprocess.run(['docker', 'compose', '-p', project, '-f', str(staged), 'config', '--quiet'],
                       check=True, cwd=compose.parent)
        os.replace(staged, compose)
        result = subprocess.run(command, check=False, cwd=compose.parent)
        if result.returncode:
            atomic_write(compose, original)
            recovery = subprocess.run(command, check=False, cwd=compose.parent)
            if recovery.returncode:
                raise RuntimeError('Switch and recovery failed; use the protected backup')
            raise RuntimeError('Switch failed; previous backend was restored')
        print(json.dumps({'provider': '9router', 'model': model, 'image': image,
                          'rollback_compose': str(backup), 'healthy': True}))
    finally:
        if staged.exists():
            staged.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compose', type=Path, required=True)
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--model', default='ag/gemini-3.8-flash-low')
    args = parser.parse_args()
    switch(args.compose, args.key_file, args.image, args.project, args.model)
