#!/usr/bin/env python3
"""Stream separately stored recovery keys into an age-encrypted tar archive."""
import io
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone


def backup_keys(directory, destination, recipient, volume_key='/etc/asinu/keys/database-volume.key'):
    os.umask(0o077)
    directory = Path(directory)
    destination = Path(destination)
    if directory.is_symlink() or not directory.is_dir() or directory.stat().st_mode & 0o077:
        raise RuntimeError('A private health key directory is required')
    fd, temporary = tempfile.mkstemp(prefix='.asinu-keys-', dir=destination)
    process = None
    try:
        process = subprocess.Popen(['age', '-r', recipient], stdin=subprocess.PIPE,
                                   stdout=fd, stderr=subprocess.DEVNULL)
        os.close(fd)
        fd = None
        with tarfile.open(fileobj=process.stdin, mode='w|') as archive:
            sources = [('users/' + name, directory / name, 32 if name.endswith('.key') else 64)
                       for name in sorted(os.listdir(directory)) if re.fullmatch(r'[1-9][0-9]*\.key(?:\.deleted)?', name)]
            volume = Path(volume_key)
            if volume.is_file():
                sources.append(('volume/database-volume.key', volume, 64))
            for name, source, maximum in sources:
                try:
                    key_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
                except FileNotFoundError:
                    continue  # owner deleted during snapshot
                try:
                    key_stat = os.fstat(key_fd)
                    if not stat.S_ISREG(key_stat.st_mode) or key_stat.st_mode & 0o077 or key_stat.st_size > maximum:
                        raise RuntimeError('Unsafe recovery key file')
                    data = os.read(key_fd, maximum + 1)
                    expected = 64 if name.startswith('volume/') else 32
                    if len(data) > maximum or (name.endswith('.key') and len(data) != expected):
                        raise RuntimeError('Invalid recovery key')
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mode = 0o600
                    archive.addfile(info, io.BytesIO(data))
                finally:
                    os.close(key_fd)
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError('Recovery key encryption failed')
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = destination / ('asinu-' + stamp + '-' + Path(temporary).name.rsplit('-', 1)[-1] + '.keys.tar.age')
        os.replace(temporary, target)
        print('Encrypted recovery key archive created:', target.name)
        return target
    finally:
        if fd is not None:
            os.close(fd)
        if process is not None:
            if process.stdin and not process.stdin.closed:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            if process.poll() is None:
                process.terminate()
            process.wait()
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    try:
        backup_keys(os.environ['HEALTH_FIELD_KEY_HOST_DIRECTORY'],
                    os.environ.get('BACKUP_DIR', '/var/backups/asinu-encrypted'),
                    os.environ['BACKUP_AGE_RECIPIENT'])
    except (KeyError, OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        raise SystemExit('Encrypted recovery key backup failed')
