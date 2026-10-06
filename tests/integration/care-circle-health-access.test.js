'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  verifyCaregiverAccess,
  updateHealthAccess,
  normalizePermissions,
} = require('../../src/services/care-circle/careCircle.service');

// Explicit opt-in. Fixtures are TEMP tables inside a transaction; no app rows
// or migration history are changed, and teardown always rolls back.
const url = process.env.CARE_CIRCLE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('directional health consent, real PostgreSQL', () => {
  let db;
  const id = '10000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    db = new Client({ connectionString: url, options: '-c statement_timeout=5000' });
    await db.connect();
    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE user_connections (
      id UUID PRIMARY KEY, requester_id INTEGER, addressee_id INTEGER,
      status TEXT, permissions JSONB NOT NULL, updated_at TIMESTAMPTZ
    ) ON COMMIT DROP`);
    await db.query(
      fs.readFileSync(
        path.join(__dirname, '../../db/migrations/102_care_circle_directional_health_access.sql'),
        'utf8'
      )
    );
  });
  beforeEach(async () => {
    await db.query('DELETE FROM pg_temp.user_connections');
    await db.query(
      `INSERT INTO pg_temp.user_connections (id, requester_id, addressee_id, status, permissions)
      VALUES ($1, 7, 8, 'accepted', '{"can_view_logs":true,"can_receive_alerts":true}')`,
      [id]
    );
  });
  afterAll(async () => {
    if (db) {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
  test('legacy consent grants requester health only, not reverse access', async () => {
    expect(await verifyCaregiverAccess(db, 8, 7)).toBe(true);
    expect(await verifyCaregiverAccess(db, 7, 8)).toBe(false);
    expect(await verifyCaregiverAccess(db, 9, 7)).toBe(false);
    expect(await verifyCaregiverAccess(db, 7, 7)).toBe(false);
  });
  test('addressee explicitly shares their own profile without changing requester consent or alerts', async () => {
    expect((await updateHealthAccess(db, id, 8, true)).ok).toBe(true);
    expect(await verifyCaregiverAccess(db, 7, 8)).toBe(true);
    const { rows } = await db.query('SELECT * FROM pg_temp.user_connections');
    expect(rows[0].permissions).toEqual({ can_view_logs: true, can_receive_alerts: true });
  });
  test('viewer cannot escalate their access by granting their own consent', async () => {
    await updateHealthAccess(db, id, 7, false);
    await updateHealthAccess(db, id, 8, true);
    expect(await verifyCaregiverAccess(db, 8, 7)).toBe(false);
    expect(await verifyCaregiverAccess(db, 7, 8)).toBe(true);
  });
  test('outsiders cannot update either direction', async () => {
    expect((await updateHealthAccess(db, id, 9, true)).statusCode).toBe(404);
    expect(await verifyCaregiverAccess(db, 7, 8)).toBe(false);
  });
  test('revocation blocks the next data request in both directions', async () => {
    await updateHealthAccess(db, id, 8, true);
    await updateHealthAccess(db, id, 7, false);
    await updateHealthAccess(db, id, 8, false);
    expect(await verifyCaregiverAccess(db, 8, 7)).toBe(false);
    expect(await verifyCaregiverAccess(db, 7, 8)).toBe(false);
  });
  test('pending connections cannot read or change consent', async () => {
    await db.query("UPDATE pg_temp.user_connections SET status = 'pending'");
    expect(await verifyCaregiverAccess(db, 8, 7)).toBe(false);
    expect((await updateHealthAccess(db, id, 7, true)).statusCode).toBe(404);
  });
  test('removed connections lose access even when the old consent was granted', async () => {
    await db.query('DELETE FROM pg_temp.user_connections');
    expect(await verifyCaregiverAccess(db, 8, 7)).toBe(false);
  });
  test('new invitations default to viewing access but explicit opt-out stays disabled', () => {
    expect(normalizePermissions(undefined).can_view_logs).toBe(true);
    expect(normalizePermissions({}).can_view_logs).toBe(true);
    expect(normalizePermissions({ can_view_logs: false }).can_view_logs).toBe(false);
    expect(normalizePermissions({ can_view_logs: 'false' }).can_view_logs).toBe(false);
  });
});
