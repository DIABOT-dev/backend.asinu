#!/usr/bin/env python3
"""Check key readiness and backup freshness independently of application processes."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import ssl
import tempfile
import time
import urllib.parse
import urllib.request
import uuid


def check_health(check, now=None):
    now = time.time() if now is None else now
    try:
        if check['type'] == 'backup':
            files = [p for p in Path(check['directory']).glob(check['pattern']) if p.is_file() and not p.is_symlink()]
            files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            if not files or now - files[0].stat().st_mtime > check['max_age_seconds']:
                return 'BACKUP_STALE'
            with files[0].open('rb') as stream:
                return None if stream.read(22) == b'age-encryption.org/v1\n' else 'BACKUP_INVALID'
        context = None
        if check['type'] == 'openbao':
            context = ssl.create_default_context(cafile=check['ca_file'])
            context.minimum_version = ssl.TLSVersion.TLSv1_3
            context.load_cert_chain(check['cert_file'], check['key_file'])
        with urllib.request.urlopen(check['url'], timeout=5, context=context) as response:
            if response.status != 200:
                return 'SERVICE_NOT_READY'
            if check['type'] == 'openbao':
                body = json.loads(response.read(16384))
                return None if body.get('initialized') is True and body.get('sealed') is False else 'OPENBAO_SEALED'
        return None
    except Exception:
        return 'OPENBAO_UNREACHABLE' if check['type'] == 'openbao' else 'SERVICE_NOT_READY'


def send_event(dsn, name, code, recovered=False):
    if not re.fullmatch(r'[a-z][a-z0-9_-]{1,63}', name) or not re.fullmatch(r'[A-Z_]{3,50}', code):
        raise RuntimeError('Invalid technical incident identifiers')
    parsed = urllib.parse.urlsplit(dsn)
    project = parsed.path.strip('/')
    if parsed.scheme != 'https' or not parsed.hostname or not parsed.username or not project.isdigit():
        raise RuntimeError('Invalid operations Sentry DSN')
    event_id = uuid.uuid4().hex
    event = {'event_id': event_id, 'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'platform': 'python', 'level': 'info' if recovered else 'error',
             'logger': 'asinu.operations', 'environment': 'production',
             'message': 'OperationsRecovered' if recovered else code,
             'fingerprint': ['asinu-operations', name], 'tags': {'component': 'operations', 'check': name, 'code': code}}
    header = {'event_id': event_id, 'dsn': dsn}
    body = ('\n'.join(json.dumps(v, separators=(',', ':')) for v in [header, {'type': 'event'}, event]) + '\n').encode()
    endpoint = parsed.scheme + '://' + parsed.netloc.rsplit('@', 1)[-1] + '/api/' + project + '/envelope/'
    request = urllib.request.Request(endpoint, data=body, headers={'Content-Type': 'application/x-sentry-envelope'})
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status not in [200, 202]:
            raise RuntimeError('Operations incident delivery failed')
    return event_id


def run(config, clock=time.time, check=check_health, deliver=send_event):
    os.umask(0o077)
    path = Path(config['state_file'])
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    state = json.loads(path.read_text()) if path.exists() else {}
    now = clock()
    failed = []
    delivery_failed = False
    for item in config['checks']:
        name = item['name']
        if not re.fullmatch(r'[a-z][a-z0-9_-]{1,63}', name):
            raise RuntimeError('Invalid check name')
        code = check(item, now)
        previous = state.get(name, {})
        sent = previous.get('last_sent_at', 0)
        changed = code != previous.get('code')
        needs_event = (code and (changed or not sent or now - sent >= 1800)) or (not code and previous.get('code'))
        next_state = {'code': code, 'last_checked_at': now, 'last_sent_at': sent}
        if code:
            failed.append({'check': name, 'code': code})
        if needs_event:
            try:
                event_id = deliver(config['sentry_dsn'], name, code or previous['code'], not code)
                next_state.update({'last_sent_at': now, 'event_id': event_id})
            except Exception:
                delivery_failed = True
                # Do not lose a pending recovery notification on delivery failure.
                next_state['code'] = previous.get('code') if not code else code
                next_state['last_sent_at'] = 0
        state[name] = next_state
    descriptor, temporary = tempfile.mkstemp(prefix='.monitor-', dir=path.parent)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(state, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    return {'healthy': not failed, 'failed': failed, 'delivery_failed': delivery_failed}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.config.stat().st_mode & 0o077:
            raise RuntimeError('Operations config must be private')
        result = run(json.loads(args.config.read_text()))
        print(json.dumps(result))
        raise SystemExit(0 if result['healthy'] and not result['delivery_failed'] else 1)
    except Exception:
        raise SystemExit('Operations monitor failed; no credentials or application data printed')
