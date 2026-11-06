#!/usr/bin/env python3
"""Encrypt an explicit legacy file; retire only after an off-host verification receipt."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def validate_source(path):
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise RuntimeError('Only explicit regular legacy files may be retired')


def encrypt(source, destination, recipient):
    os.umask(0o077)
    source, destination = Path(source), Path(destination)
    validate_source(source)
    if not re.fullmatch(r'age1[0-9a-z]+', recipient):
        raise RuntimeError('Public age recipient required')
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.is_symlink() or destination.stat().st_mode & 0o077:
        raise RuntimeError('Private destination required')
    before = digest(source)
    target = destination / (source.name + '.' + before[:12] + '.age')
    if not target.exists():
        descriptor, temporary = tempfile.mkstemp(prefix='.retiring-', dir=destination)
        try:
            with source.open('rb') as original, os.fdopen(descriptor, 'wb') as output:
                result = subprocess.run(['age', '-r', recipient], stdin=original, stdout=output,
                                        stderr=subprocess.DEVNULL, timeout=300)
                output.flush()
                os.fsync(output.fileno())
            if result.returncode or digest(source) != before:
                raise RuntimeError('Source changed or encryption failed; original retained')
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return {'source': str(source), 'encrypted': str(target), 'plaintext_sha256': before,
            'encrypted_sha256': digest(target), 'offhost_verified': False}


def retire(receipt):
    if receipt.get('offhost_verified') is not True:
        raise RuntimeError('Off-host decryption and digest verification is required')
    source, encrypted = Path(receipt['source']), Path(receipt['encrypted'])
    validate_source(source)
    if encrypted.is_symlink() or digest(encrypted) != receipt['encrypted_sha256']:
        raise RuntimeError('Encrypted replacement changed; original retained')
    if digest(source) != receipt['plaintext_sha256']:
        raise RuntimeError('Original changed; refusing retirement')
    source.unlink()
    return {'source': str(source), 'original_removed': True, 'encrypted_recovery': str(encrypted)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.config.stat().st_mode & 0o077:
            raise RuntimeError('Private operator config required')
        config = json.loads(args.config.read_text())
        result = retire(config['receipt']) if config.get('operation') == 'retire' else encrypt(
            config['source'], config['destination'], config['recipient'])
        print(json.dumps(result))
    except Exception:
        raise SystemExit('Legacy retirement stopped; original retained unless verified removal completed')
