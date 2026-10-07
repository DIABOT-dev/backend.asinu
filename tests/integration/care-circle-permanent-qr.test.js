'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

jest.mock('../../src/services/notification/basic.notification.service', () => ({ sendAndSave: jest.fn() }));
jest.mock('../../src/services/payment/entitlement.service', () => ({
  getEntitlement: jest.fn().mockResolvedValue({ connectionLimit: 8, isAnTam: true }),
}));
jest.mock('../../src/lib/redis', () => ({ cacheGet: jest.fn().mockResolvedValue('Relative'), cacheSet: jest.fn() }));
jest.mock('../../src/services/integrations/crm-event.service', () => ({ emitCrmEventAsync: jest.fn() }));
const service = require('../../src/services/care-circle/careCircle.service');
const url = process.env.CARE_CIRCLE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const migration = file => fs.readFileSync(path.join(__dirname, '../../db/migrations', file), 'utf8');

// Every fixture is TEMP and rolled back. No application rows are touched.
suite('Permanent Care Circle QR, real PostgreSQL', () => {
  let db;
  beforeAll(async () => {
    db = new Client({ connectionString: url, options: '-c statement_timeout=5000' });
    await db.connect(); await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE users (
      id INTEGER PRIMARY KEY, display_name TEXT, full_name TEXT, email TEXT,
      avatar_url TEXT, push_token TEXT, language_preference TEXT
    )`);
    await db.query(migration('095_care_circle_qr_tokens.sql').replace('CREATE TABLE', 'CREATE TEMP TABLE'));
    await db.query(`CREATE TEMP TABLE user_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), requester_id INTEGER, addressee_id INTEGER,
      requested_by INTEGER, status TEXT, relationship_type TEXT, role TEXT, permissions JSONB,
      created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    )`);
    await db.query(`CREATE UNIQUE INDEX qr_test_connection_pair ON user_connections
      (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))`);
    await db.query("INSERT INTO users (id, display_name) VALUES (1,'Parent'), (2,'Child'), (3,'Relative')");
    await db.query(`INSERT INTO care_circle_qr_tokens (owner_user_id, token_hash, expires_at)
      VALUES (1, $1, NOW() - INTERVAL '1 day')`, [hash('legacy'.repeat(8))]);
    await db.query(migration('106_permanent_care_circle_qr.sql'));
    await db.query(migration('106_permanent_care_circle_qr.sql'));
  });
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end(); } });

  test('migration preserves historical rows and permits only one permanent code per account', async () => {
    const first = await service.createQrToken(db, 1);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toHaveProperty('expiresAt');
    const repeats = await Promise.all(Array.from({ length: 10 }, () => service.createQrToken(db, 1)));
    expect(repeats.every(code => code.token === first.token && code.value === first.value)).toBe(true);
    const rows = (await db.query('SELECT token_value, expires_at FROM pg_temp.care_circle_qr_tokens WHERE owner_user_id=1')).rows;
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.token_value === first.token && row.expires_at === null)).toHaveLength(1);
    await db.query('SAVEPOINT duplicate_owner');
    try {
      await expect(db.query(`INSERT INTO pg_temp.care_circle_qr_tokens (owner_user_id, token_hash, token_value)
        VALUES (1, $1, $2)`, [hash('z'.repeat(43)), 'z'.repeat(43)]))
        .rejects.toMatchObject({ code: '23505', constraint: 'idx_care_circle_qr_tokens_permanent_owner' });
    } finally { await db.query('ROLLBACK TO SAVEPOINT duplicate_owner'); }
  });

  test('accounts have different codes and old expired codes are not resurrected', async () => {
    const first = await service.createQrToken(db, 1);
    const second = await service.createQrToken(db, 2);
    expect(second.token).not.toBe(first.token);
    expect(await service.previewQrToken(db, 'legacy'.repeat(8), 2))
      .toMatchObject({ ok: false, code: 'CARE_CIRCLE_QR_INVALID' });
    expect(await service.previewQrToken(db, first.token, 1))
      .toMatchObject({ ok: false, code: 'CARE_CIRCLE_QR_SELF' });
    expect(await service.previewQrToken(db, first.token, 2))
      .toEqual({ ok: true, preview: { name: 'Parent', avatarUrl: null } });
  });

  test('multiple relatives reuse one code, invitations remain pending and duplicates stay blocked', async () => {
    const code = await service.createQrToken(db, 1);
    for (const requester of [2, 3]) {
      expect(await service.createInvitationFromQr(db, requester, { token: code.token, role: 'than-nhan', permissions: { can_view_logs: false } }))
        .toMatchObject({ ok: true, invitation: { requester_id: requester, addressee_id: 1,
          status: 'pending', permissions: { can_view_logs: false } } });
    }
    expect(await service.previewQrToken(db, code.token, 2))
      .toMatchObject({ ok: false, code: 'CARE_CIRCLE_CONNECTION_EXISTS' });
    const row = (await db.query('SELECT consumed_at, revoked_at, expires_at FROM pg_temp.care_circle_qr_tokens WHERE token_value=$1', [code.token])).rows[0];
    expect(row).toEqual({ consumed_at: null, revoked_at: null, expires_at: null });
    expect(await service.createQrToken(db, 1)).toEqual(code);
  });

  test('deleting an account removes its permanent QR', async () => {
    const code = await service.createQrToken(db, 3);
    await db.query('DELETE FROM pg_temp.users WHERE id=3');
    expect((await db.query('SELECT * FROM pg_temp.care_circle_qr_tokens WHERE token_value=$1', [code.token])).rowCount).toBe(0);
    expect(await service.previewQrToken(db, code.token, 2)).toMatchObject({ code: 'CARE_CIRCLE_QR_INVALID' });
  });
});
