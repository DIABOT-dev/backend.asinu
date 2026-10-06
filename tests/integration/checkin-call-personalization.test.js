'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
jest.mock('../../src/services/payment/entitlement.service', () => ({
  getEntitlement: jest.fn(async () => ({ callCenterEnabled: true })),
}));
jest.mock('../../src/services/checkin-call/weather.service', () => ({
  ...jest.requireActual('../../src/services/checkin-call/weather.service'),
  forecast: jest.fn(async () => null),
}));
const service = require('../../src/services/checkin-call/personalization.service');
const url = process.env.CHECKIN_PERSONALIZATION_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
// Explicit test DB only. Every fixture and the actual migration live in an
// isolated schema in one transaction, always rolled back; never load .env.
suite('personalized check-in speech, real PostgreSQL', () => {
  let db;
  beforeAll(async () => {
    db = new Client({ connectionString: url, options: '-c statement_timeout=5000' });
    await db.connect();
    await db.query('BEGIN');
    await db.query('CREATE SCHEMA checkin_personalization_test');
    await db.query('SET LOCAL search_path TO checkin_personalization_test');
    await db.query(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, display_name TEXT, deleted_at TIMESTAMPTZ);
      CREATE TABLE user_onboarding_profiles (user_id INTEGER PRIMARY KEY, display_name TEXT, gender TEXT, date_of_birth DATE, birth_year INTEGER, age TEXT);
      CREATE TABLE checkin_call_settings (user_id INTEGER PRIMARY KEY, timezone TEXT);
      CREATE TABLE checkin_call_episodes (id UUID PRIMARY KEY, user_id INTEGER, severity TEXT);
      CREATE TABLE checkin_call_attempts (id UUID PRIMARY KEY, episode_id UUID, target_user_id INTEGER, target_role TEXT);
      CREATE TABLE logs_common (id UUID PRIMARY KEY, user_id INTEGER, log_type TEXT, occurred_at TIMESTAMPTZ);
      CREATE TABLE blood_pressure_logs (log_id UUID PRIMARY KEY, systolic INTEGER, diastolic INTEGER);
      CREATE TABLE glucose_logs (log_id UUID PRIMARY KEY, value NUMERIC, unit TEXT);
      INSERT INTO users VALUES (7,'Nguyễn Thị Lan',NULL,NULL),(8,'Nguyễn Văn Nam',NULL,NULL);
      INSERT INTO user_onboarding_profiles (user_id, gender, age) VALUES (7,'Nữ','60+');
      INSERT INTO checkin_call_settings VALUES (7,'Asia/Ho_Chi_Minh');
      INSERT INTO checkin_call_episodes VALUES ('10000000-0000-4000-8000-000000000001',7,'NONE');
      INSERT INTO checkin_call_attempts VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',7,'USER'),
        ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',8,'FAMILY');
      INSERT INTO logs_common VALUES ('30000000-0000-4000-8000-000000000001',7,'blood_pressure',now()-interval '1 hour');
      INSERT INTO blood_pressure_logs VALUES ('30000000-0000-4000-8000-000000000001',125,80);
    `);
    const migration = fs.readFileSync(
      path.join(__dirname, '../../db/migrations/103_checkin_call_voice_preferences.sql'),
      'utf8'
    );
    await db.query(migration);
    await db.query(migration);
  });
  afterAll(async () => {
    if (db) {
      try {
        await db.query('ROLLBACK');
      } finally {
        await db.end();
      }
    }
  });

  test('migration is idempotent and creates a private per-user default, not consent for existing users', async () => {
    expect(
      (await db.query('SELECT count(*) FROM checkin_call_voice_preferences')).rows[0].count
    ).toBe('0');
    expect((await service.preferences(db, 7)).preferences).toEqual(service.DEFAULTS);
  });
  test('real upsert and health query produce an own-user context with the declared schema', async () => {
    const saved = await service.savePreferences(db, 7, {
      use_name: true,
      use_health: true,
      address: 'auto',
    });
    expect(saved).toMatchObject({ use_name: true, use_health: true });
    const notice = await service.userNotice(db, '20000000-0000-4000-8000-000000000001', 7);
    expect(notice.prompts.user_prompt).toContain('bác Nguyễn Thị Lan');
    expect(notice.context).toContain('125');
    expect((await service.preferences(db, 8)).preferences.use_name).toBe(false);
  });
  test('neither a different user nor a family recipient can fetch private user prompts', async () => {
    await expect(
      service.userNotice(db, '20000000-0000-4000-8000-000000000001', 8)
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.userNotice(db, '20000000-0000-4000-8000-000000000002', 8)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  test('turning optional fields off deletes coordinates and updates the next spoken snapshot', async () => {
    await service.savePreferences(db, 7, {
      use_name: true,
      weather_enabled: true,
      region: 'device',
      location: { latitude: 10.762622, longitude: 106.660172 },
    });
    expect((await service.preferences(db, 7)).preferences.location).toEqual({
      latitude: 10.8,
      longitude: 106.7,
    });
    await service.savePreferences(db, 7, {});
    expect((await service.preferences(db, 7)).preferences.location).toBeNull();
    expect(
      (await service.userNotice(db, '20000000-0000-4000-8000-000000000001', 7)).greeting
    ).not.toContain('Lan');
  });
  test('deleting a user cascades to optional voice preferences', async () => {
    await service.savePreferences(db, 8, {});
    await db.query('DELETE FROM users WHERE id=8');
    expect(
      (await db.query('SELECT user_id FROM checkin_call_voice_preferences WHERE user_id=8')).rows
    ).toHaveLength(0);
  });
});
