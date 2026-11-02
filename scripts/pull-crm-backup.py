#!/usr/bin/env python3
"""Receive only ciphertext over a dedicated, pinned, forced-command SSH identity."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def receive(stream, destination, max_bytes=512 * 1024 * 1024, now=None):
    metadata = json.loads(stream.readline(8192))
    if not re.fullmatch(r'crm-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{6})?\.dump\.age', metadata['file']):
        raise RuntimeError('Invalid remote archive name')
    size = metadata['encrypted_bytes']
    if type(size) is not int or not 100 < size <= max_bytes or not re.fullmatch(r'[a-f0-9]{64}', metadata['sha256']):
        raise RuntimeError('Invalid remote backup size or checksum')
    stamp = datetime.datetime.fromisoformat(metadata['last_success_at']).timestamp()
    now = time.time() if now is None else now
    if not 0 <= now - stamp <= 7200:
        raise RuntimeError('Remote backup is stale or dated in the future')
    descriptor, temporary = tempfile.mkstemp(prefix='.incoming-', dir=destination)
    try:
        digest = hashlib.sha256()
        with os.fdopen(descriptor, 'wb') as output:
            remaining = size
            first = stream.read(22)
            if first != b'age-encryption.org/v1\n':
                raise RuntimeError('Remote backup is not ciphertext')
            digest.update(first)
            output.write(first)
            remaining -= len(first)
            while remaining:
                block = stream.read(min(1024 * 1024, remaining))
                if not block:
                    raise RuntimeError('Truncated remote backup')
                digest.update(block)
                output.write(block)
                remaining -= len(block)
            if stream.read(1) or digest.hexdigest() != metadata['sha256']:
                raise RuntimeError('Backup checksum or stream length mismatch')
            output.flush()
            os.fsync(output.fileno())
        # Preserve source creation time: re-pulling an old archive cannot hide staleness.
        os.utime(temporary, (stamp, stamp))
        os.replace(temporary, destination / metadata['file'])
        return metadata
    finally:
        Path(temporary).unlink(missing_ok=True)


def prune(destination, now):
    # Keep 48 hours of hourly copies plus one copy per older day, for 14 days.
    seen = set()
    files = sorted(destination.glob('crm-*.dump.age'), key=lambda p: p.stat().st_mtime, reverse=True)
    for index, file in enumerate(files):
        stamp = file.stat().st_mtime
        day = datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).date()
        keep = index < 2 or now - stamp < 48 * 3600 or (now - stamp < 14 * 86400 and day not in seen)
        seen.add(day)
        if not keep:
            file.unlink()


def pull(config):
    os.umask(0o077)
    destination = Path(config['destination'])
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.is_symlink() or destination.stat().st_mode & 0o077:
        raise RuntimeError('A private recovery directory is required')
    with (destination / '.pull.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        process = subprocess.Popen(['ssh', '-T', '-i', config['identity'], '-o', 'IdentitiesOnly=yes',
                                    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                    '-o', 'UserKnownHostsFile=' + config['known_hosts'], '-o', 'ConnectTimeout=15',
                                    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', config['remote']],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            result = receive(process.stdout, destination)
            if process.wait(timeout=15):
                raise RuntimeError('Remote backup transfer failed')
            prune(destination, time.time())
            return result
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
            process.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.config.stat().st_mode & 0o077:
            raise RuntimeError('Private receiver config required')
        print(json.dumps(pull(json.loads(args.config.read_text()))))
    except Exception:
        raise SystemExit('Off-server CRM backup failed; no credential or plaintext was printed')
