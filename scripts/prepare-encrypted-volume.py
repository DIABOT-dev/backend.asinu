#!/usr/bin/env python3
"""Create a NEW LUKS2 data volume. Never formats a block device or existing file.

Does not move databases. The separate migration procedure must quiesce writers,
copy data, verify recovery and only then switch the production bind mounts.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess


def prepare():
    if os.geteuid() != 0:
        raise SystemExit('Volume preparation requires root')
    directory = Path('/var/lib/asinu-encrypted')
    image = directory / 'database.luks'
    key_directory = Path('/etc/asinu/keys')
    key = key_directory / 'database-volume.key'
    mountpoint = Path('/srv/asinu-data')
    mapping = 'asinu_data'
    size = 8 * 1024 ** 3
    for command in ['cryptsetup', 'mkfs.ext4', 'mount', 'blkid', 'findmnt']:
        if not shutil.which(command):
            raise SystemExit('Missing volume tool: ' + command)
    for path in [image, key, directory / 'volume.json', Path('/dev/mapper') / mapping]:
        if path.exists() or path.is_symlink():
            raise SystemExit('Refusing to overwrite existing volume/key/mapping: ' + str(path))
    if mountpoint.exists() and (mountpoint.is_symlink() or any(mountpoint.iterdir())):
        raise SystemExit('Encrypted mountpoint must be new and empty')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    key_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    os.chmod(key_directory, 0o700)
    if shutil.disk_usage(directory).free < size + 4 * 1024 ** 3:
        raise SystemExit('Insufficient space; no data was changed')
    fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    try:
        os.write(fd, os.urandom(64))
        os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(image, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.posix_fallocate(fd, 0, size)
        os.fsync(fd)
    finally:
        os.close(fd)
    # This is the exclusively-created regular file above, never /dev/vda.
    subprocess.run(['cryptsetup', 'luksFormat', '--batch-mode', '--type', 'luks2',
                    '--cipher', 'aes-xts-plain64', '--key-size', '512',
                    '--pbkdf', 'argon2id', '--pbkdf-memory', '262144',
                    '--pbkdf-parallel', '2', '--iter-time', '2000',
                    '--key-file', str(key), str(image)], check=True)
    subprocess.run(['cryptsetup', 'open', '--key-file', str(key), str(image), mapping], check=True)
    device = '/dev/mapper/' + mapping
    subprocess.run(['mkfs.ext4', '-q', '-L', 'asinu-encrypted', device], check=True)
    mountpoint.mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.run(['mount', '-o', 'nodev,nosuid,noexec', device, str(mountpoint)], check=True)
    os.chmod(mountpoint, 0o700)
    state = {'image': str(image), 'mapping': mapping, 'mountpoint': str(mountpoint),
             'key_file': str(key), 'size_bytes': size, 'cipher': 'aes-xts-plain64',
             'aes_key_bits': 256, 'luks_version': 2,
             'luks_uuid': subprocess.check_output(['cryptsetup', 'luksUUID', str(image)], text=True).strip(),
             'filesystem_uuid': subprocess.check_output(['blkid', '-s', 'UUID', '-o', 'value', device], text=True).strip(),
             'key_custody': 'root-only key on VPS for automatic boot; independent recovery copy required',
             'database_migrated': False}
    state_file = directory / 'volume.json'
    state_file.write_text(json.dumps(state, indent=2) + '\n')
    os.chmod(state_file, 0o600)
    print('New 8 GiB LUKS2 volume prepared; production databases untouched')


if __name__ == '__main__':
    os.umask(0o077)
    prepare()
