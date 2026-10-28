'use strict';
// Run only in an isolated maintenance process. Never mount this as an HTTP API.
// Production content is decrypted in memory and represented only by an aggregate
// digest. Synthetic writes use a temporary SQL table and are always rolled back.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const service = process.env.CRYPTO_PROBE_SERVICE;
let phase = 'initialize';
let runtime;
let pool;

async function main() {
  const managed = process.env.KEY_MANAGEMENT_PROVIDER === 'openbao';
  if (managed) process.env.OPENBAO_KEY_CACHE_TTL_SECONDS = '30';
  const prefix = service === 'asinu' ? './src/' : './dist/';
  const rootRequire = filename => require(path.resolve(prefix + filename));
  let networkDown = false, clockOffset = 0;
  if (managed) {
    runtime = rootRequire('security/openbao-keyring.cjs');
    const originalHttp = runtime.Keyring.prototype.httpRequest;
    const originalReady = runtime.Keyring.prototype.ready;
    runtime.Keyring.prototype.httpRequest = function (...args) {
      return networkDown ? Promise.reject(runtime.unavailable()) : originalHttp.apply(this, args);
    };
    runtime.Keyring.prototype.ready = function () {
      this.now = () => Date.now() + clockOffset;
      return originalReady.call(this);
    };
    await runtime.initializeKeyring();
  }
  const digest = crypto.createHash('sha256');
  const counts = {};
  const add = (table, id, field, value) => {
    digest.update(JSON.stringify([table, id, field, value]));
    counts[table] = (counts[table] || 0) + 1;
  };
  const report = { service, managed, originalKeyFilesVerified: 0 };
  let encryptFixture, decryptFixture;

  if (service === 'asinu') {
    const fields = rootRequire('security/health-field-encryption');
    if (process.env.CRYPTO_PROBE_CONVERT_KEYS === 'true') {
      phase = 'protect-original-health-keys';
      const envelope = rootRequire('security/health-key-envelope');
      const legacy = '/run/asinu-health-legacy';
      const target = process.env.HEALTH_FIELD_KEY_DIRECTORY;
      for (const name of fs.readdirSync(legacy)) {
        if (/^[1-9][0-9]*\.key\.deleted$/u.test(name)) {
          fs.copyFileSync(path.join(legacy, name), path.join(target, name));
          fs.chmodSync(path.join(target, name), 0o600);
        } else if (/^[1-9][0-9]*\.key$/u.test(name)) {
          const key = fs.readFileSync(path.join(legacy, name));
          if (key.length !== 32) throw new Error('Original key format is invalid');
          const user = name.slice(0, -4);
          const next = envelope.protectHealthKey(user, key);
          if (!crypto.timingSafeEqual(envelope.unprotectHealthKey(user, next), key)) throw new Error('Key mismatch');
          const temporary = path.join(target, name + '.migration');
          const fd = fs.openSync(temporary, 'w', 0o600);
          try { fs.writeFileSync(fd, next); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(temporary, path.join(target, name));
          report.originalKeyFilesVerified += 1;
        }
      }
    }
    phase = 'read-legacy-health-data';
    pool = rootRequire('lib/db').createPool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const specs = rootRequire('security/health-field-specs');
    for (const spec of specs) {
      const result = await pool.query(`SELECT t.${spec.id}::text AS probe_id,t.${spec.owner}::text AS probe_owner,${spec.fields.map(field => 't.' + field).join(',')} FROM ${spec.table} t JOIN users u ON u.id=t.${spec.owner} WHERE u.deleted_at IS NULL ORDER BY t.${spec.id}`);
      for (const row of result.rows) for (const field of spec.fields) {
        if (row[field] != null) add(spec.table, row.probe_id, field, fields.decryptHealthField(row.probe_owner, spec.table + '.' + field, row[field]));
      }
    }
    const originalDirectory = process.env.HEALTH_FIELD_KEY_DIRECTORY;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openbao-key-write-'));
    fs.chmodSync(temporary, 0o700);
    process.env.HEALTH_FIELD_KEY_DIRECTORY = temporary;
    const keyCipher = fields.encryptHealthField(42, 'chat_histories.message', 'OpenBao synthetic fixture');
    if (fields.decryptHealthField(42, 'chat_histories.message', keyCipher) !== 'OpenBao synthetic fixture') throw new Error('New user round trip failed');
    report.newUserKeyProtectedOnDisk = !managed || fs.readFileSync(path.join(temporary, '42.key')).toString().startsWith('asinu:key:v2:');
    encryptFixture = value => fields.encryptHealthField(42, 'chat_histories.message', value);
    decryptFixture = value => fields.decryptHealthField(42, 'chat_histories.message', value);
    report.cleanup = () => {
      process.env.HEALTH_FIELD_KEY_DIRECTORY = originalDirectory;
      fs.rmSync(temporary, { recursive: true, force: true });
    };
  } else if (service === 'doctor') {
    phase = 'read-legacy-doctor-data';
    const fields = rootRequire('security/field-encryption');
    const { env } = rootRequire('config/env');
    pool = rootRequire('db/pool').createPool(env.databaseUrl);
    const result = await pool.query('SELECT id::text,account_number FROM doctor_bank_accounts ORDER BY id');
    for (const row of result.rows) add('doctor_bank_accounts', row.id, 'account_number', fields.decryptSensitiveValue(row.account_number));
    const subject = rootRequire('modules/integrations/asinu/patient-events.service').patientSubjectRef('openbao-probe', '42');
    report.publicSubjectRef = subject;
    encryptFixture = fields.encryptSensitiveValue;
    decryptFixture = fields.decryptSensitiveValue;
  } else if (service === 'crm') {
    phase = 'read-current-crm-data';
    const secrets = rootRequire('security/secret.service');
    const pii = rootRequire('security/contact-pii');
    pool = rootRequire('db/pool').db;
    const targets = [
      ['crm_contacts', 'id::text', ['phone_ciphertext', 'email_ciphertext'], secrets.decryptContactPii],
      ['crm_ai_provider_configs', "tenant_id::text||':'||provider_code", ['api_key_ciphertext'], secrets.decryptSecret],
      ['crm_marketing_provider_configs', "tenant_id::text||':'||provider_code", ['credentials_ciphertext'], secrets.decryptSecret],
      ['crm_agent_mcp_configs', 'tenant_id::text', ['external_api_key_ciphertext'], secrets.decryptSecret],
    ];
    let hashesVerified = 0;
    for (const [table, identity, columns, decrypt] of targets) {
      const extra = table === 'crm_contacts' ? ',phone_hash,email_hash' : '';
      const result = await pool.query(`SELECT ${identity} AS probe_id,${columns.join(',')}${extra} FROM ${table} ORDER BY 1`);
      for (const row of result.rows) for (const column of columns) {
        if (row[column] == null) continue;
        const plain = decrypt(row[column]);
        add(table, row.probe_id, column, plain);
        if (table === 'crm_contacts' && row[column.replace('_ciphertext', '_hash')] != null) {
          if (pii.hashContactValue(plain) !== row[column.replace('_ciphertext', '_hash')]) throw new Error('Contact lookup hash mismatch');
          hashesVerified += 1;
        }
      }
    }
    report.lookupHashesVerified = hashesVerified;
    encryptFixture = secrets.encryptContactPii;
    decryptFixture = secrets.decryptContactPii;
    report.envFileInImage = fs.existsSync(path.resolve('.env'));
    if (managed && report.envFileInImage) throw new Error('A plaintext environment file is baked into the image');
  } else throw new Error('Unknown probe service');

  phase = 'transactional-write-read';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMPORARY TABLE openbao_crypto_probe(value text) ON COMMIT DROP');
    const text = 'OpenBao kiểm tra đọc và ghi dữ liệu';
    const encrypted = encryptFixture(text);
    if (encrypted.includes(text)) throw new Error('Plaintext storage detected');
    await client.query('INSERT INTO openbao_crypto_probe(value) VALUES($1)', [encrypted]);
    const result = await client.query('SELECT value FROM openbao_crypto_probe');
    if (decryptFixture(result.rows[0].value) !== text) throw new Error('Stored ciphertext round trip failed');
    await client.query('ROLLBACK');
    report.transactionalWriteReadRolledBack = true;
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  if (report.cleanup) { report.cleanup(); delete report.cleanup; }

  if (managed) {
    phase = 'key-service-outage';
    const slot = service === 'asinu' ? 'health-key-wrap' : service === 'doctor' ? 'doctor-data' : 'crm-pii';
    networkDown = true;
    let refreshFailed = false;
    try { await runtime.refreshKeyring(); } catch { refreshFailed = true; }
    if (!refreshFailed) throw new Error('Expected refresh failure');
    if (!runtime.getKeyBytes(slot).length) throw new Error('Valid memory cache not available');
    clockOffset = 31000;
    let expiredRejected = false;
    try { runtime.getKeyBytes(slot); } catch (error) { expiredRejected = error.code === 'SERVICE_UNAVAILABLE'; }
    if (!expiredRejected) throw new Error('Expired keys were accepted');
    clockOffset = 0; networkDown = false;
    await runtime.refreshKeyring();
    if (!runtime.getKeyBytes(slot).length) throw new Error('Key service recovery failed');
    report.injectedOutage = { cacheServedBeforeExpiry: true, expiredCacheRejected: true, reconnectedToRealOpenBao: true };
  }
  report.fieldCounts = counts;
  report.dataDigest = digest.digest('hex');
  console.log(JSON.stringify(report));
}
main().catch(error => {
  console.log(JSON.stringify({ failed: true, phase, code: /^[A-Z0-9_]{1,64}$/u.test(error.code || '') ? error.code : 'PROBE_FAILED' }));
  process.exitCode = 1;
}).finally(async () => {
  if (pool) await pool.end();
  runtime?.stopKeyring();
});
