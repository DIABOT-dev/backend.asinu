#!/usr/bin/env python3
"""Inspect or manually unseal Asinu OpenBao through a verified SSH tunnel.

Recovery material stays on the operator's machine. No shares, tokens, or
passwords are printed, passed as command arguments, or copied to either VPS.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import urllib.request


def operate(action, private_directory, identity):
    context = ssl.create_default_context(cafile=private_directory / 'ca.crt')
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(private_directory / 'operator.crt',
                            private_directory / 'operator.key')
    # macOS's per-user TMPDIR can exceed the Unix socket path length limit.
    with tempfile.TemporaryDirectory(prefix='asinu-bao-', dir='/tmp') as directory:
        control = str(Path(directory) / 'ssh-control')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        host = 'root@103.173.227.247'
        subprocess.run(['ssh', '-M', '-S', control, '-fNT',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
            '-o', 'IdentitiesOnly=yes',
            '-o', 'ConnectTimeout=15', '-o', 'ControlPersist=no',
            '-L', f'127.0.0.1:{port}:127.0.0.1:8200', host], check=True)
        try:
            def request(path, value=None):
                data = json.dumps(value).encode() if value is not None else None
                req = urllib.request.Request(f'https://127.0.0.1:{port}/v1/' + path,
                    data=data, headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, context=context, timeout=15) as response:
                    return json.load(response)

            status = request('sys/seal-status')
            if action == 'unseal' and status['sealed']:
                plaintext = subprocess.run(['age', '-d', '-i', str(identity),
                    str(private_directory / 'recovery.json.age')],
                    capture_output=True, check=True).stdout
                shares = json.loads(plaintext)['unsealKeys']
                for share in shares:
                    status = request('sys/unseal', {'key': share})
                    if not status['sealed']:
                        break
                if status['sealed']:
                    raise RuntimeError('OpenBao remains sealed')
            return {key: status.get(key) for key in
                    ['initialized', 'sealed', 't', 'n', 'progress', 'version']}
        finally:
            subprocess.run(['ssh', '-S', control, '-O', 'exit', host],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'unseal'])
    parser.add_argument('--private-directory', type=Path,
        default=Path.home() / '.config/asinu-security/openbao-20261028')
    parser.add_argument('--identity', type=Path,
        default=Path.home() / '.config/asinu-security/openbao-recovery.identity')
    args = parser.parse_args()
    try:
        print(json.dumps(operate(args.action, args.private_directory, args.identity)))
    except Exception:
        raise SystemExit('OpenBao operation failed. Check SSH, certificates, and the local recovery files; no secret was printed.')
