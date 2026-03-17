#!/usr/bin/env node

/**
 * Reset Database Script
 * Drop all tables, re-run init.sql + all migrations.
 *
 * Usage:
 *   node scripts/reset-db.js
 *   npm run db:reset
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

async function reset() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    // 1. Drop all tables
    await client.query(`
      DO $$ DECLARE r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    console.log('✓ All tables dropped');

    // 2. Drop custom types
    await client.query('DROP TYPE IF EXISTS auth_provider CASCADE');
    console.log('✓ Custom types dropped');

    // 3. Run init.sql
    const initSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'init.sql'), 'utf8');
    await client.query(initSql);
    console.log('✓ init.sql applied');

    // 4. Run all migrations
    const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  applied ${file}`);
    }

    console.log(`\n✓ Database reset complete (${files.length} migrations applied)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Reset failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

reset();
