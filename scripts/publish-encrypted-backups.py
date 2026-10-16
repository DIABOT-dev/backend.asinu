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
# Prune only encrypted key archives after a new successful backup job.
# Database retention is managed by backup-db.sh; no private key is published.
cutoff = time.time() - int(os.environ.get('BACKUP_RETENTION_DAYS', '14')) * 86400
archives = sorted(directory.glob('asinu-*.keys.tar.age'), key=lambda f: f.stat().st_mtime)
for file in archives[:-1]:
    if file.stat().st_mtime < cutoff:
        file.unlink()
