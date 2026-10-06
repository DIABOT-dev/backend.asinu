'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Opt-in, isolated TEMP fixtures. Nothing is committed to the application database.
const url = process.env.CARE_CIRCLE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('Care Circle family role migration, real PostgreSQL', () => {
  let db;
  let beforeRows;
  const fixtures = [
    ['Thân nhân', 'than-nhan'], ['Người thân', 'than-nhan'],
    [' Family member ', 'than-nhan'], ['RELATIVE', 'than-nhan'],
    ['Người thân'.normalize('NFD'), 'than-nhan'], ['family', 'than-nhan'], ['gia đình', 'than-nhan'],
    ['Người chăm sóc', 'nguoi-cham-soc'], ['Người chăm sóc chính', 'nguoi-cham-soc'],
    ['Người thân chăm sóc chính', 'nguoi-cham-soc'], ['Primary Caregiver', 'nguoi-cham-soc'],
    ['FAMILY CAREGIVER', 'nguoi-cham-soc'], ['caregiver', 'nguoi-cham-soc'],
    ['than-nhan', 'than-nhan'], ['nguoi-cham-soc', 'nguoi-cham-soc'],
    ['bac-si', null], ['Bác sĩ', null], ['Chuyên gia gia đình', null], ['Family Specialist', null],
    ['y-ta', null], ['duoc-si', null], ['chuyen-gia-dinh-duong', null], ['huan-luyen-vien', null],
    ['nguoi-ho-tro', null], ['nguoi-giup-viec', null], ['tu-van-tam-ly', null], ['Custom professional', null],
    ['', null], [null, null],
  ];
  beforeAll(async () => {
    db = new Client({ connectionString: url, options: '-c statement_timeout=5000' });
    await db.connect();
    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE user_connections (
      id INTEGER PRIMARY KEY, role TEXT, status TEXT, permissions JSONB,
      addressee_can_view_logs BOOLEAN, updated_at TIMESTAMPTZ
    ) ON COMMIT DROP`);
    for (const [index, [role]] of fixtures.entries()) {
      await db.query(`INSERT INTO pg_temp.user_connections
        VALUES ($1, $2, $3, $4::jsonb, $5, '2026-10-01T01:00:00Z')`, [
        index + 1, role, index % 2 ? 'pending' : 'accepted',
        JSON.stringify({ can_view_logs: index % 2 === 0, can_receive_alerts: true, can_ack_escalation: false }),
        index % 3 === 0,
      ]);
    }
    beforeRows = (await db.query('SELECT * FROM pg_temp.user_connections ORDER BY id')).rows;
    await db.query(fs.readFileSync(path.join(__dirname, '../../db/migrations/104_care_circle_family_roles.sql'), 'utf8'));
  });
  afterAll(async () => {
    if (db) {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  test('normalizes supported historical labels and clears professional roles without inventing family relationships', async () => {
    const { rows } = await db.query('SELECT * FROM pg_temp.user_connections ORDER BY id');
    expect(rows.map((row) => row.role)).toEqual(fixtures.map(([, expected]) => expected));
    expect(rows.length).toBe(beforeRows.length);
  });

  test('existing statuses, viewing consent, alerts and timestamps are preserved', async () => {
    const withoutRole = ({ role: _role, ...rest }) => rest;
    const { rows } = await db.query('SELECT * FROM pg_temp.user_connections ORDER BY id');
    expect(rows.map(withoutRole)).toEqual(beforeRows.map(withoutRole));
  });

  test('the database rejects new professional roles even if application validation is bypassed', async () => {
    await db.query('SAVEPOINT invalid_role');
    try {
      await expect(db.query("UPDATE pg_temp.user_connections SET role = 'bac-si' WHERE id = 1"))
        .rejects.toMatchObject({ code: '23514', constraint: 'user_connections_family_role_check' });
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT invalid_role');
      await db.query('RELEASE SAVEPOINT invalid_role');
    }
    expect((await db.query('SELECT role FROM pg_temp.user_connections WHERE id=1')).rows[0].role).toBe('than-nhan');
  });

  test('family roles and an unset optional role remain writable', async () => {
    for (const role of ['than-nhan', 'nguoi-cham-soc', null]) {
      await db.query('UPDATE pg_temp.user_connections SET role = $1 WHERE id = 1', [role]);
      expect((await db.query('SELECT role FROM pg_temp.user_connections WHERE id=1')).rows[0].role).toBe(role);
    }
  });
});
