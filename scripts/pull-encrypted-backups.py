#!/usr/bin/env python3
"""Pull encrypted backups using a pinned, read-only SFTP identity.

Requires only macOS/OpenSSH, age and gzip. No VPS root password is stored.
The private age identity and decrypted data never leave the recovery machine.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tarfile
from datetime import datetime, timezone, timedelta


def validate_backup(incoming, identity, key_archive=False):
    process = subprocess.Popen(['age', '-d', '-i', identity, str(incoming)],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        if key_archive:
            with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
                for member in archive:
                    if not member.isfile() or not (re.fullmatch(r'users/[1-9][0-9]*\.key(?:\.deleted)?', member.name)
                                                   or member.name == 'volume/database-volume.key'):
                        raise RuntimeError('Unexpected recovery archive member')
                    maximum = 64 if member.name.endswith('.deleted') or member.name.startswith('volume/') else 32
                    if member.size > maximum or (member.name.endswith('.key') and member.size != maximum):
                        raise RuntimeError('Invalid recovery key archive')
            # tar can stop before the age stream ends. Consume the remainder so
            # authentication covers the entire ciphertext, including its tail.
            while process.stdout.read(65536):
                pass
            valid = True
        else:
            valid = subprocess.run(['gzip', '-t'], stdin=process.stdout,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        process.stdout.close()
        returncode = process.wait()
        if not valid or returncode != 0:
            raise RuntimeError('Encrypted backup validation failed')
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
        process.wait()


def prune_backups(destination, retention_days):
    if not isinstance(retention_days, int) or retention_days < 1:
        raise ValueError('Invalid backup retention')
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    for suffix, label in (('.sql.gz.age', 'main'), ('.sql.gz.age', 'doctor'), ('.keys.tar.age', 'keys')):
        candidates = []
        for entry in destination.iterdir():
            match = re.fullmatch(r'asinu-(\d{8}T\d{6}Z)-[A-Za-z0-9_-]+' + re.escape(suffix), entry.name)
            if suffix == '.sql.gz.age' and ('-doctor-' in entry.name) != (label == 'doctor'):
                continue
            if match and entry.is_file() and not entry.is_symlink():
                stamp = datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
                candidates.append((stamp, entry))
        # Keep the latest two copies even after a long outage. Prune only after
        # a successful sync, never when the remote endpoint is unavailable.
        for stamp, entry in sorted(candidates, key=lambda item: item[0], reverse=True)[2:]:
            if stamp < cutoff:
                entry.unlink()


def require_fresh_recovery_sets(names):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=36)
    for kind in ('main', 'doctor', 'keys'):
        stamps = []
        for name in names:
            match = re.match(r'asinu-(\d{8}T\d{6}Z)-', name)
            if not match:
                continue
            group = 'keys' if name.endswith('.keys.tar.age') else ('doctor' if '-doctor-' in name else 'main')
            if group == kind:
                stamps.append(datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc))
        if not stamps or max(stamps) < cutoff:
            raise RuntimeError('A required daily recovery set is missing or stale')


def prune_legacy_copies(config):
    private_root = Path(config['age_identity']).expanduser().resolve().parent
    cutoff = datetime.now(timezone.utc).timestamp() - config.get('retention_days', 14) * 86400
    for location in config.get('legacy_directories', []):
        directory = Path(location).expanduser()
        if directory.is_symlink() or directory.resolve().parent != private_root:
            raise RuntimeError('Legacy copies must be in the private recovery directory')
        for file in directory.glob('*.age'):
            if file.is_symlink() or not file.is_file():
                continue
            with file.open('rb') as stream:
                if stream.read(22) != b'age-encryption.org/v1\n':
                    raise RuntimeError('Invalid legacy ciphertext')
            if file.stat().st_mtime < cutoff:
                file.unlink()


def run_sftp(config, commands, directory=None):
    args = ['sftp', '-q', '-b', '-', '-i', config['ssh_identity'],
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + config['known_hosts'],
            '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
            '-o', 'ConnectTimeout=15', config['remote']]
    return subprocess.run(args, input='\n'.join(commands) + '\n', text=True,
                          cwd=directory, capture_output=True, check=True).stdout


def pull(config):
    destination = Path(config['destination']).expanduser()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination, 0o700)
    lock = open(destination / '.pull.lock', 'a')
    os.chmod(destination / '.pull.lock', 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0
    try:
        listing = run_sftp(config, ['ls -1 /'])
        # Ignore command echoes, traversal paths and all non-backup files.
        names = sorted({line.strip().lstrip('/') for line in listing.splitlines()
                        if re.fullmatch(r'/?asinu-[A-Za-z0-9_-]+\.(?:sql\.gz|keys\.tar)\.age', line.strip())})
        if not names:
            raise RuntimeError('No encrypted backups returned by the pinned server')
        require_fresh_recovery_sets(names)
        copied = 0
        for name in names:
            target = destination / name
            if target.is_symlink():
                raise RuntimeError('Backup destination must not be a symlink')
            if target.is_file():
                continue
            with tempfile.TemporaryDirectory(prefix='.incoming-', dir=destination) as temporary:
                run_sftp(config, ['get /' + name + ' backup.age'], temporary)
                incoming = Path(temporary) / 'backup.age'
                os.chmod(incoming, 0o600)
                # Authenticate all ciphertext before accepting this recovery copy.
                validate_backup(incoming, config['age_identity'], name.endswith('.keys.tar.age'))
                incoming.replace(target)
                copied += 1
        prune_backups(destination, config.get('retention_days', 14))
        prune_legacy_copies(config)
        status = {'last_success_at': datetime.now(timezone.utc).isoformat(),
                  'copied': copied, 'available': len(names), 'remote': config['remote']}
        status_file = destination / 'status.json'
        status_file.write_text(json.dumps(status, indent=2) + '\n')
        os.chmod(status_file, 0o600)
        print('Encrypted off-server backup sync succeeded:', copied, 'new files')
        return copied
    finally:
        lock.close()


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        pull(json.loads(Path(args.config).read_text()))
    except (OSError, ValueError, RuntimeError, tarfile.TarError, subprocess.SubprocessError):
        raise SystemExit('Encrypted backup sync failed; no unverified file was accepted')
