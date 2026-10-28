#!/usr/bin/env python3
"""Unlock the existing LUKS volume using its OpenBao-protected original key.

The plaintext key is passed over stdin to cryptsetup, never via a persistent
file, command argument, environment variable, or log. --test never mounts,
detaches, formats, or changes the active volume.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import ssl
import subprocess
import urllib.request


def recover_volume_key(config):
    context = ssl.create_default_context(cafile=config['ca_file'])
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(config['cert_file'], config['key_file'])
    address = config['address'].rstrip('/')

    def request(path, data, token=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Vault-Token'] = token
        req = urllib.request.Request(address + '/v1/' + path,
            data=json.dumps(data).encode(), headers=headers)
        with urllib.request.urlopen(req, context=context, timeout=10) as response:
            return json.load(response)

    bundle = json.loads(Path(config['bundle_file']).read_text())
    if bundle['version'] != 1 or bundle['role'] != config['role']:
        raise RuntimeError('Invalid volume key bundle')
    entries = [item for item in bundle['entries'] if item['id'] == 'volume-unlock']
    if len(entries) != 1:
        raise RuntimeError('Invalid volume key bundle')
    token = request('auth/cert/login', {'name': config['role']})['auth']['client_token']
    try:
        response = request('transit/decrypt/' + bundle['transit_key'], {
            'ciphertext': entries[0]['ciphertext'],
            'associated_data': base64.b64encode(
                ('asinu:keyring:v1:' + config['role'] + ':volume-unlock').encode()).decode(),
        }, token)
        key = bytearray(base64.b64decode(response['data']['plaintext'], validate=True))
        if len(key) != 64:
            raise RuntimeError('Invalid volume key')
        return key
    finally:
        try:
            request('auth/token/revoke-self', {}, token)
        except Exception:
            pass


def unlock(config, test=False):
    if not test:
        active = subprocess.run(['cryptsetup', 'status', config['mapping']],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if active.returncode == 0:
            return
    key = recover_volume_key(config)
    try:
        args = ['cryptsetup', 'open', '--type', 'luks', '--key-file', '-']
        if test:
            args.append('--test-passphrase')
        args.append(config['device'])
        if not test:
            args.append(config['mapping'])
        result = subprocess.run(args, input=key, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=45)
        if result.returncode:
            raise RuntimeError('Volume key validation failed')
    finally:
        key[:] = b'\0' * len(key)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--test', action='store_true')
    args = parser.parse_args()
    try:
        unlock(json.loads(Path(args.config).read_text()), args.test)
        print('Volume key validated' if args.test else 'Encrypted volume is available')
    except Exception:
        raise SystemExit('Encrypted volume unavailable; check OpenBao and recovery access. No key was printed.')
