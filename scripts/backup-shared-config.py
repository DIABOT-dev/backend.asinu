#!/usr/bin/env python3
"""Replace the legacy plaintext shared-config tar job with streaming age encryption."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def backup(config):
    os.umask(0o077)
    source = Path(config['source'])
    destination = Path(config['destination'])
    if source.is_symlink() or not source.is_dir() or not re.fullmatch(r'age1[0-9a-z]+', config['recipient']):
        raise RuntimeError('Invalid private backup configuration')
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.is_symlink() or destination.stat().st_mode & 0o077:
        raise RuntimeError('Backup destination must be private')
    fd, temporary = tempfile.mkstemp(prefix='.pending-shared-', dir=destination)
    producer = None
    try:
        producer = subprocess.Popen(['tar', '-C', str(source.parent), '-czf', '-', source.name],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        with os.fdopen(fd, 'wb') as output:
            encrypted = subprocess.run(['age', '-r', config['recipient']], stdin=producer.stdout,
                                       stdout=output, stderr=subprocess.DEVNULL, timeout=120)
            producer.stdout.close()
            code = producer.wait(timeout=20)
            output.flush()
            os.fsync(output.fileno())
        if code or encrypted.returncode:
            raise RuntimeError('Archive stream failed')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = destination / ('shared-' + stamp + '-' + Path(temporary).name.rsplit('-', 1)[-1] + '.tar.gz.age')
        os.replace(temporary, target)
        return {'file': target.name, 'encrypted_bytes': target.stat().st_size}
    finally:
        Path(temporary).unlink(missing_ok=True)
        if producer is not None and producer.poll() is None:
            producer.kill()
            producer.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.config.stat().st_mode & 0o077:
            raise RuntimeError('Private config required')
        print(json.dumps(backup(json.loads(args.config.read_text()))))
    except Exception:
        raise SystemExit('Encrypted shared backup failed; no credentials printed')
