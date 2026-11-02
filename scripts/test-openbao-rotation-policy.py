#!/usr/bin/env python3
"""Exercise rotation ACLs against a disposable OpenBao in a separate network namespace."""
import argparse,json,os,re,subprocess,tempfile,time,urllib.request,urllib.error
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary',type=Path,required=True)
parser.add_argument('--policy',type=Path,default=Path(__file__).resolve().parents[1]/'deploy/openbao/operator-rotation-policy.hcl')
args=parser.parse_args()
if not Path('/proc/1/ns/net').exists() or os.readlink('/proc/self/ns/net')==os.readlink('/proc/1/ns/net'):
 raise SystemExit('Run this test under unshare --net; production network/storage is never used')
subprocess.run(['ip','link','set','lo','up'],check=True,capture_output=True)
policy=args.policy.read_text()
keys=['asinu-health','asinu-doctor','asinu-crm','asinu-crm-volume']
base='http://127.0.0.1:18207/v1/'
with tempfile.TemporaryDirectory(prefix='asinu-rotation-policy-test-',dir='/run') as folder:
 logfile=Path(folder)/'server.log'
 with logfile.open('wb') as log:
  process=subprocess.Popen([str(args.binary),'server','-dev','-dev-no-store-token','-dev-listen-address=127.0.0.1:18207','-log-level=error'],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,env={k:v for k,v in os.environ.items() if not k.startswith(('BAO_','VAULT_'))})
  try:
   root=None
   for _ in range(100):
    content=logfile.read_text(errors='replace');found=re.search(r'Root Token:\s+(\S+)',content)
    if found:root=found.group(1);break
    if process.poll() is not None:raise RuntimeError('Isolated test instance failed to start')
    time.sleep(.1)
   if not root:raise RuntimeError('Isolated test startup timed out')
   def request(path,value=None,token=None):
    headers={'X-Vault-Token':token or root,'Content-Type':'application/json'}
    req=urllib.request.Request(base+path,data=json.dumps(value).encode() if value is not None else None,headers=headers)
    try:
     with urllib.request.urlopen(req,timeout=5) as response:
      body=response.read();return response.status,json.loads(body) if body else {}
    except urllib.error.HTTPError as e:return e.code,{}
   def expect(path,value,status,token=None):
    got,body=request(path,value,token)
    if got not in (status if isinstance(status,tuple) else (status,)):raise RuntimeError('ACL semantics check failed for '+path+': '+str(got))
    return body
   expect('sys/mounts/transit',{'type':'transit'},204)
   for key in keys:expect('transit/keys/'+key,{},(200,204))
   old='path "transit/keys/*" { capabilities = ["read", "list"] }\npath "transit/keys/+/rotate" { capabilities = ["update"] }\n'
   expect('sys/policies/acl/scoped-operator',{'policy':old+policy},204)
   token=expect('auth/token/create',{'policies':['scoped-operator'],'ttl':'5m','no_default_policy':True},200)['auth']['client_token']
   checks=[]
   for key in keys:
    expect('transit/keys/'+key+'/config',{'auto_rotate_period':7776000},(200,204),token)
    metadata=expect('transit/keys/'+key,None,200,token)['data']
    if metadata['auto_rotate_period']!=7776000 or metadata['exportable'] or metadata['allow_plaintext_backup']:raise RuntimeError('Key metadata invariant failed')
    for extra in [{'exportable':True},{'deletion_allowed':True},{'min_decryption_version':2},{'min_encryption_version':2},{'allow_plaintext_backup':True}]:
     expect('transit/keys/'+key+'/config',{'auto_rotate_period':7776000,**extra},403,token)
    expect('transit/keys/'+key+'/config',{},403,token)
    expect('transit/keys/'+key+'/rotate',{},(200,204),token)
    checks.append(key)
   expect('transit/keys/unrelated',{},(200,204))
   expect('transit/keys/unrelated/config',{'auto_rotate_period':7776000},403,token)
   expect('sys/policies/acl/scoped-operator',{'policy':old},403,token)
   expect('auth/cert/certs/operator',{},403,token)
   print(json.dumps({'isolatedInMemoryOpenBao':'2.7.2','productionStateTouched':False,'keySchedulesAllowed':checks,'unsafeKeyParametersRejectedPerKey':5,'emptyConfigRejected':True,'otherKeyScheduleRejected':True,'policyAndAuthenticationAdministrationRejected':True,'existingManualRotationAllowed':True}))
  finally:
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:process.kill();process.wait()
