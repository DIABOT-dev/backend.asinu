'use strict';

// Run as the DBA, separately from the API. No admin credential is copied into
// the runtime environment. Supply the new password in a mode-0600 file.
const fs = require('fs');
const { Client } = require('pg');
const { databaseOptions } = require('../src/lib/database-options');
const quote = value => '"' + value.replace(/"/g, '""') + '"';

async function provisionRuntimeRole(client, role, password) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(role) || /^(postgres|pg_)/.test(role)) throw new Error('Invalid dedicated runtime role');
  if (typeof password !== 'string' || password.length < 32 || /[\r\n\0]/.test(password)) throw new Error('Use a random password of at least 32 characters');
  await client.query('BEGIN');
  try {
    const { rows: [context] } = await client.query('SELECT current_user AS admin, current_database() AS db');
    if (role === context.admin) throw new Error('Runtime and migration roles must be different');
    const { rows: memberships } = await client.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1', [role]);
    if (memberships.length) throw new Error('Runtime role must not be a member of another role');
    const { rows: owners } = await client.query("SELECT DISTINCT tableowner AS name FROM pg_tables WHERE schemaname = 'public' UNION SELECT current_user UNION SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()");
    const { rows: [existing] } = await client.query('SELECT oid FROM pg_roles WHERE rolname = $1', [role]);
    if (existing) {
      const { rows: [owned] } = await client.query('SELECT count(*)::int AS n FROM pg_shdepend WHERE refobjid = $1 AND deptype = $2', [existing.oid, 'o']);
      if (owned.n) throw new Error('Runtime role already owns objects; use a new dedicated role');
    } else await client.query(`CREATE ROLE ${quote(role)}`);
    // Password must be a SQL literal for ALTER ROLE. It never appears in logs.
    await client.query(`ALTER ROLE ${quote(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password.replace(/'/g, "''")}'`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(context.db)} TO ${quote(role)}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quote(role)}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quote(role)}`);
    for (const owner of owners) {
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(owner.name)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quote(role)}`);
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(owner.name)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quote(role)}`);
    }
    for (const table of ['schema_migrations', 'distillation_data']) {
      const { rows: [result] } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`]);
      if (result.present) await client.query(`REVOKE INSERT, UPDATE, DELETE ON ${quote(table)} FROM ${quote(role)}`);
    }
    const { rows: [privileges] } = await client.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS schema_create, has_database_privilege($1, current_database(), 'CREATE') AS db_create", [role]);
    if (privileges.schema_create || privileges.db_create) throw new Error('PUBLIC grants allow DDL; review and revoke PUBLIC CREATE before provisioning');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const file = process.env.RUNTIME_DATABASE_PASSWORD_FILE;
  if (!file || (fs.statSync(file).mode & 0o077)) throw new Error('A private runtime password file (mode 0600) is required');
  const client = new Client(databaseOptions(process.env.DATABASE_URL));
  await client.connect();
  try {
    await provisionRuntimeRole(client, process.env.RUNTIME_DATABASE_ROLE || 'asinu_runtime', fs.readFileSync(file, 'utf8').trim());
    console.log('Dedicated runtime role provisioned; DDL and training writes denied');
  } finally { await client.end(); }
}
if (require.main === module) main().catch(() => { console.error('Runtime role provisioning failed; review database privileges and protected configuration'); process.exitCode = 1; });
module.exports = { provisionRuntimeRole };
