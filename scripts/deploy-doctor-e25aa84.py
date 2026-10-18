import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

STACK = Path('/opt/stacks/asinu-doctor')
COMMIT = 'e25aa8481a81614efadba585f2ada8992ca54629'
IMAGE = 'asinu-doctor-frontend:ui-e25aa84'
CANARY = 'asinu-doctor-frontend-canary-e25aa84'
BACKUP = Path('/root/asinu-doctor-release-e25aa84')
CONFIG = STACK / 'compose.asinu-vps.json'
BUNDLE = Path('/tmp/asinu-doctor-e25aa84.bundle')

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]

def request(url):
    with urllib.request.urlopen(url, timeout=8) as result:
        return result.status, result.read()

def wait(url):
    for _ in range(30):
        try:
            if request(url)[0] == 200:
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Frontend did not become ready')

def up():
    run(['docker', 'compose', '-p', 'asinu-doctor', '-f', str(CONFIG),
         'up', '-d', '--no-deps', '--no-build', 'doctor-frontend'])

assert hashlib.sha256(BUNDLE.read_bytes()).hexdigest() == '5afa4e4fd8b8f4f72efb86726a8bd8ba99503cd3958a46a5d958f27e3cf20bd6'
BACKUP.mkdir(mode=0o700, exist_ok=False)
before = CONFIG.read_bytes()
(BACKUP / 'compose.before.json').write_bytes(before)
os.chmod(BACKUP / 'compose.before.json', 0o600)
frontend = inspect('asinu-doctor-frontend')
protected = {name: inspect(name)['Id'] for name in ['asinu-doctor-backend', 'asinu-doctor-postgres']}
metadata = {'commit': COMMIT, 'previous_frontend_image': frontend['Image'], 'protected_containers': protected}
(BACKUP / 'deployment.json').write_text(json.dumps(metadata, indent=2))
git = ['git', '-c', f'safe.directory={STACK}', '-C', str(STACK)]
run(git + ['fetch', str(BUNDLE), 'HEAD'])
run(git + ['merge', '--ff-only', 'FETCH_HEAD'])
assert subprocess.check_output(git + ['rev-parse', 'HEAD']).decode().strip() == COMMIT
print('Source updated; building frontend image before switching traffic.', flush=True)
with (BACKUP / 'build.log').open('w') as log:
    result = subprocess.run(['docker', 'build', '--label', f'org.opencontainers.image.revision={COMMIT}',
                             '-t', IMAGE, str(STACK / 'frontend')], stdout=log, stderr=subprocess.STDOUT)
if result.returncode:
    print('\n'.join((BACKUP / 'build.log').read_text().splitlines()[-35:]), flush=True)
    raise RuntimeError('Frontend image build failed; live containers were not changed')

created = False
switched = False
try:
    network = next(iter(frontend['NetworkSettings']['Networks']))
    backend_url = next(value for value in frontend['Config']['Env'] if value.startswith('DOCTOR_BACKEND_URL='))
    run(['docker', 'run', '-d', '--name', CANARY, '--network', network,
         '-p', '127.0.0.1::3000', '-e', backend_url, IMAGE], stdout=subprocess.DEVNULL)
    created = True
    port = inspect(CANARY)['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']
    wait(f'http://127.0.0.1:{port}/vi/login')
    assert b'doctor-login-hero-v3.png' in request(f'http://127.0.0.1:{port}/vi/login')[1]
    expected = hashlib.sha256((STACK / 'frontend/public/images/doctor-login-hero-v3.png').read_bytes()).hexdigest()
    assert hashlib.sha256(request(f'http://127.0.0.1:{port}/images/doctor-login-hero-v3.png')[1]).hexdigest() == expected
    print('Canary login and image verified; updating the frontend service.', flush=True)
    config = json.loads(before)
    service = config['services']['doctor-frontend']
    service['image'] = IMAGE
    service['build']['context'] = str(STACK / 'frontend')
    # Keep future builds pointed at the canonical, up-to-date source checkout.
    config['services']['doctor-backend']['build']['context'] = str(STACK / 'backend')
    temp = CONFIG.with_suffix('.next.json')
    temp.write_text(json.dumps(config, indent=2))
    os.chmod(temp, 0o600)
    temp.replace(CONFIG)
    switched = True
    up()
    wait('http://127.0.0.1:3510/vi/login')
    wait('https://dr.asinu.vn/vi/login')
    assert b'doctor-login-hero-v3.png' in request('https://dr.asinu.vn/vi/login')[1]
    assert hashlib.sha256(request('https://dr.asinu.vn/images/doctor-login-hero-v3.png')[1]).hexdigest() == expected
    assert request('http://127.0.0.1:3500/readyz')[0] == 200
    for name, container_id in protected.items():
        assert inspect(name)['Id'] == container_id, f'{name} was unexpectedly recreated'
    assert inspect('asinu-doctor-frontend')['Config']['Labels']['org.opencontainers.image.revision'] == COMMIT
    (BACKUP / 'completed.json').write_text(json.dumps({'commit': COMMIT, 'image': IMAGE, 'login': 200,
        'backend_ready': 200, 'new_asset_verified': True, 'backend_and_database_preserved': True}, indent=2))
    print('DEPLOY_SUCCESS: e25aa84, public login 200, new artwork verified, backend/database preserved.', flush=True)
except Exception:
    if switched:
        CONFIG.write_bytes(before)
        os.chmod(CONFIG, 0o600)
        up()
        wait('http://127.0.0.1:3510/vi/login')
        print('Previous frontend restored after failed verification.', flush=True)
    raise
finally:
    if created:
        subprocess.run(['docker', 'rm', '-f', CANARY], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
