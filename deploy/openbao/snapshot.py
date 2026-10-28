#!/usr/bin/env python3
"""Create an age-encrypted, off-host Raft snapshot using a snapshot-only role.

Run on the application VPS, not the OpenBao VPS. Neither unseal shares nor
the private age recovery identity are required or accepted by this program.
"""
import argparse
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import urllib.request


def snapshot(config):
    context = ssl.create_default_context(cafile=config['ca_file'])
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(config['cert_file'], config['key_file'])
    address = config['address'].rstrip('/')
    login = urllib.request.Request(address + '/v1/auth/cert/login',
        data=json.dumps({'name': config['role']}).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(login, context=context, timeout=15) as response:
        token = json.load(response)['auth']['client_token']
    headers = {'X-Vault-Token': token}
    destination = Path(config['destination'])
    destination.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(destination, 0o700)
    age = None
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.incoming-', dir=destination,
                                          delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, 0o600)
            age = subprocess.Popen(['age', '-r', config['age_recipient']],
                stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL)
            request = urllib.request.Request(address + '/v1/sys/storage/raft/snapshot',
                                             headers=headers)
            with urllib.request.urlopen(request, context=context, timeout=120) as response:
                total = 0
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    age.stdin.write(chunk)
            age.stdin.close()
            if age.wait(timeout=30) != 0 or total == 0:
                raise RuntimeError('Snapshot encryption failed')
            output.flush()
            os.fsync(output.fileno())
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = destination / ('openbao-' + stamp + '.snap.age')
        temporary.replace(target)
        temporary = None
        cutoff = datetime.now(timezone.utc) - timedelta(days=config.get('retention_days', 14))
        archives = sorted(destination.glob('openbao-????????T??????Z.snap.age'))
        for entry in archives[:-2]:
            if entry.is_file() and not entry.is_symlink() and entry.stat().st_mtime < cutoff.timestamp():
                entry.unlink()
        status = {'last_success_at': datetime.now(timezone.utc).isoformat(),
                  'file': target.name, 'encrypted_bytes': target.stat().st_size}
        status_file = destination / 'status.json'
        status_file.write_text(json.dumps(status, indent=2) + '\n')
        os.chmod(status_file, 0o600)
        return status
    finally:
        if age is not None and age.poll() is None:
            age.kill()
            age.wait()
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        try:
            request = urllib.request.Request(address + '/v1/auth/token/revoke-self',
                data=b'{}', headers={**headers, 'Content-Type': 'application/json'})
            urllib.request.urlopen(request, context=context, timeout=10).close()
        except Exception:
            pass  # Short-lived credentials expire even if revocation is unavailable.


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(snapshot(json.loads(Path(args.config).read_text()))))
    except Exception:
        raise SystemExit('OpenBao snapshot failed; no incomplete backup was accepted')
