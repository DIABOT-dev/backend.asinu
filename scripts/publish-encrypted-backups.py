#!/usr/bin/env python3
"""Grant a read-only backup group access only to completed age ciphertext."""
import grp
import os
from pathlib import Path
import stat
import time

directory = Path(os.environ.get('BACKUP_DIR', '/var/backups/asinu-encrypted'))
group = grp.getgrnam(os.environ['BACKUP_READ_GROUP']).gr_gid
for file in directory.glob('asinu-*.age'):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or os.read(fd, 22) != b'age-encryption.org/v1\n':
            raise SystemExit('Refusing to publish an invalid encrypted backup')
        os.fchown(fd, 0, group)
        os.fchmod(fd, 0o640)
    finally:
        os.close(fd)
# Include the unlabeled archives created before per-database naming, keeping
# recovery copies separately for each database and for the key bundle.
cutoff = time.time() - int(os.environ.get('BACKUP_RETENTION_DAYS', '14')) * 86400
for suffix, label in [('.sql.gz.age', 'main'), ('.sql.gz.age', 'doctor'), ('.keys.tar.age', 'keys')]:
    archives = [file for file in directory.glob('asinu-*' + suffix)
                if label == 'keys' or ('-doctor-' in file.name) == (label == 'doctor')]
    archives.sort(key=lambda f: f.stat().st_mtime)
    for file in archives[:-2]:
        if file.stat().st_mtime < cutoff:
            file.unlink()

# Migration recovery archives have the same bounded retention. These paths
# are explicitly provisioned by the operator, never supplied by API clients.
for location in os.environ.get('LEGACY_ENCRYPTED_BACKUP_DIRS', '').split(':'):
    if not location:
        continue
    legacy = Path(location)
    if legacy.is_symlink() or legacy.resolve().parent != Path('/var/backups'):
        raise SystemExit('Invalid legacy backup directory')
    for file in legacy.glob('*.age'):
        if file.is_symlink() or not file.is_file():
            continue
        with file.open('rb') as stream:
            if stream.read(22) != b'age-encryption.org/v1\n':
                raise SystemExit('Invalid legacy ciphertext')
        if file.stat().st_mtime < cutoff:
            file.unlink()
