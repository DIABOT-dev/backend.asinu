#!/usr/bin/env python3
"""Pass URI credentials to libpq through its environment, never through argv."""
import os
import re
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

try:
    uri = urlsplit(os.environ['DATABASE_URL'])
    if uri.scheme not in ('postgres', 'postgresql') or not uri.path.strip('/'):
        raise ValueError('Invalid PostgreSQL URL')
    values = {'PGDATABASE': unquote(uri.path[1:])}
    for source, target in [(uri.hostname, 'PGHOST'), (uri.port, 'PGPORT'),
                           (uri.username, 'PGUSER'), (uri.password, 'PGPASSWORD')]:
        if source is not None:
            values[target] = unquote(str(source))
    options = {'sslmode': 'PGSSLMODE', 'sslrootcert': 'PGSSLROOTCERT',
               'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY',
               'connect_timeout': 'PGCONNECT_TIMEOUT', 'application_name': 'PGAPPNAME'}
    for key, value in parse_qsl(uri.query):
        if key not in options:
            raise ValueError('Unsupported connection option')
        values[options[key]] = value
    os.environ.update(values)
    os.environ.pop('DATABASE_URL', None)
    if len(sys.argv) < 2 or sys.argv[1] not in ('pg_dump', 'psql'):
        raise ValueError('Invalid PostgreSQL command')
except (KeyError, ValueError):
    sys.exit('Invalid protected database configuration')
container = os.environ.get('POSTGRES_CONTAINER')
if container:
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', container):
        sys.exit('Invalid PostgreSQL container')
    args = ['docker', 'exec', '-i']
    for name in ['PGDATABASE', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', *options.values()]:
        if name in os.environ:
            args.extend(['--env', name])
    args.extend([container, *sys.argv[1:]])
    os.execvp('docker', args)
os.execvp(sys.argv[1], sys.argv[1:])
