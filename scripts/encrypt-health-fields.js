'use strict';

const { Client } = require('pg');
const { databaseOptions } = require('../src/lib/database-options');
const { PREFIX, encryptHealthField, decryptHealthField } = require('../src/security/health-field-encryption');
const specs = require('../src/security/health-field-specs');

async function encryptExistingHealthFields(client) {
  if (process.env.HEALTH_FIELD_ENCRYPTION_ENABLED !== 'true') throw new Error('Health encryption must be configured before backfill');
  let changed = 0;
  for (const spec of specs) {
    const exists = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + spec.table]);
    if (!exists.rows[0].present) continue;
    let last = null;
    for (;;) {
      const page = await client.query(`SELECT ${[spec.id, spec.owner, ...spec.fields].join(', ')} FROM ${spec.table} WHERE ${spec.owner} IS NOT NULL ${last == null ? '' : `AND ${spec.id} > $1`} ORDER BY ${spec.id} LIMIT 250`, last == null ? [] : [last]);
      if (!page.rows.length) break;
      for (const row of page.rows) {
        for (const field of spec.fields) {
          const original = row[field];
          if (original == null) continue;
          const label = `${spec.table}.${field}`;
          if (original.startsWith(PREFIX)) {
            decryptHealthField(row[spec.owner], label, original);
            continue;
          }
          const encrypted = encryptHealthField(row[spec.owner], label, original);
          // Concurrent patient/Doctor updates win; never replace a newer value.
          const updated = await client.query(`UPDATE ${spec.table} SET ${field} = $2 WHERE ${spec.id} = $1 AND ${field} IS NOT DISTINCT FROM $3`, [row[spec.id], encrypted, original]);
          changed += updated.rowCount;
        }
      }
      last = page.rows[page.rows.length - 1][spec.id];
    }
  }
  return changed;
}

async function main() {
  const client = new Client(databaseOptions(process.env.DATABASE_URL));
  await client.connect();
  try { console.log('Health field backfill complete; encrypted values:', await encryptExistingHealthFields(client)); }
  finally { await client.end(); }
}
if (require.main === module) main().catch(() => { console.error('Health encryption backfill failed; originals and keys retained for recovery'); process.exitCode = 1; });
module.exports = { encryptExistingHealthFields };
