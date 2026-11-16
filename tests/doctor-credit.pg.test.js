'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
jest.mock('../src/lib/redis', () => ({
  cacheDel: jest.fn(async () => {}),
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
}));
const {
  reserveConsultationCredit,
  settleConsultationCredit,
  consultationCreditSummary,
} = require('../src/services/payment/consultation-credit.service');
const databaseUrl = process.env.DOCTOR_CARE_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('consultation credit policy on isolated PostgreSQL', () => {
  let admin, pool, schema, household;
  beforeEach(async () => {
    const url = new URL(databaseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '55442');
    assert.equal(url.pathname, '/doctor_security_test');
    admin = new Pool({ connectionString: databaseUrl });
    schema = `credit_${crypto.randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
      max: 8,
    });
    await pool.query('CREATE TABLE users(id INTEGER PRIMARY KEY, deleted_at TIMESTAMPTZ)');
    await pool.query('CREATE TABLE doctor_task_outbox(tenant_id TEXT,payload JSONB)');
    const migration = fs
      .readFileSync(
        path.join(__dirname, '../db/migrations/094_asinu_v2_entitlements_and_early_signals.sql'),
        'utf8'
      )
      .split('ALTER TABLE iap_receipts')[0];
    await pool.query(migration);
    await pool.query(
      fs.readFileSync(
        path.join(__dirname, '../db/migrations/133_doctor_credit_reservations.sql'),
        'utf8'
      )
    );
    await pool.query('INSERT INTO users(id) VALUES(1),(2),(3)');
    household = (
      await pool.query(
        "INSERT INTO subscription_households(owner_user_id,plan_code,status,billing_period,protected_member_limit,current_period_end) VALUES(1,'antam_2','active','yearly',2,NOW()+INTERVAL '1 year') RETURNING id"
      )
    ).rows[0].id;
    await pool.query(
      'INSERT INTO subscription_household_members(household_id,user_id,added_by) VALUES($1,1,1),($1,2,1)',
      [household]
    );
    await pool.query(
      "INSERT INTO consultation_credit_ledger(household_id,delta,reason,reference_id) VALUES($1,2,'annual_grant','demo-yearly')",
      [household]
    );
  });
  afterEach(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function reserve(user, task, tenant = 'demo-clinic') {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const result = await reserveConsultationCredit(db, user, tenant, task);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  const balance = async () =>
    Number((await pool.query('SELECT SUM(delta) AS n FROM consultation_credit_ledger')).rows[0].n);
  test('retrying a legacy queued request never reserves a newly available gift', async () => {
    await pool.query(
      "INSERT INTO doctor_task_outbox(tenant_id,payload) VALUES('demo-clinic',$1::jsonb)",
      [JSON.stringify({ payload: { task_id: 'demo-legacy-retry', app_user_id: '1' } })]
    );
    expect((await reserve(1, 'demo-legacy-retry')).state).toBe('none');
    expect((await consultationCreditSummary(pool, 1)).available).toBe(1);
    await settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-legacy-retry', 'completed');
    expect(await balance()).toBe(2);
  });
  test('reserves on request and debits only on completed lifecycle, once', async () => {
    expect((await reserve(1, 'demo-one')).state).toBe('reserved');
    expect(await balance()).toBe(2);
    expect((await consultationCreditSummary(pool, 1)).available).toBe(0);
    await settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-one', 'accepted');
    expect(await balance()).toBe(2);
    await settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-one', 'completed');
    expect(await balance()).toBe(1);
    await Promise.all(
      [1, 2, 3].map(() => settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-one', 'completed'))
    );
    expect(await balance()).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int n FROM consultation_credit_ledger WHERE reason='consultation_used'"
        )
      ).rows[0].n
    ).toBe(1);
  });
  test.each(['cancelled', 'expired', 'failed', 'emergency_referred', 'forwarded'])(
    '%s releases a reservation without manufacturing a refund credit',
    async (status) => {
      await reserve(1, 'demo-cancel');
      await settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-cancel', status);
      await settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-cancel', status);
      expect(await balance()).toBe(2);
      expect((await consultationCreditSummary(pool, 1)).available).toBe(1);
      expect((await reserve(1, 'demo-retry')).state).toBe('reserved');
    }
  );
  test('concurrent requests respect the promised one credit per protected person', async () => {
    const results = await Promise.all([
      reserve(1, 'demo-a'),
      reserve(1, 'demo-b'),
      reserve(2, 'demo-c'),
    ]);
    expect(results.filter((r) => r.state === 'reserved')).toHaveLength(2);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int n FROM doctor_consultation_credit_reservations WHERE user_id=1 AND state='reserved'"
        )
      ).rows[0].n
    ).toBe(1);
    expect(await balance()).toBe(2);
  });
  test('duplicate task id is stable and cannot be claimed by another patient or tenant', async () => {
    const [a, b] = await Promise.all([reserve(1, 'demo-duplicate'), reserve(1, 'demo-duplicate')]);
    expect(a.state).toBe('reserved');
    expect(b.state).toBe('reserved');
    await expect(reserve(2, 'demo-duplicate')).rejects.toMatchObject({
      code: 'DOCTOR_TASK_IDEMPOTENCY_CONFLICT',
    });
    await expect(reserve(1, 'demo-duplicate', 'other-clinic')).rejects.toMatchObject({
      code: 'DOCTOR_TASK_IDEMPOTENCY_CONFLICT',
    });
    expect(
      (await pool.query('SELECT COUNT(*)::int n FROM doctor_consultation_credit_reservations'))
        .rows[0].n
    ).toBe(1);
  });
  test('free, monthly, unprotected and empty-credit users retain the existing consultation path', async () => {
    expect((await reserve(3, 'unprotected')).state).toBe('none');
    await pool.query("UPDATE subscription_households SET billing_period='monthly' WHERE id=$1", [
      household,
    ]);
    expect((await reserve(1, 'monthly')).state).toBe('none');
    await pool.query("UPDATE subscription_households SET plan_code='free' WHERE id=$1", [
      household,
    ]);
    expect((await reserve(1, 'free')).state).toBe('none');
    await pool.query(
      "UPDATE subscription_households SET plan_code='antam_2',billing_period='yearly' WHERE id=$1",
      [household]
    );
    await pool.query('DELETE FROM consultation_credit_ledger');
    expect((await reserve(1, 'empty')).state).toBe('none');
    expect((await consultationCreditSummary(pool, 1)).legacy_consultation_available).toBe(true);
  });
  test('debit failures roll back the reservation state for a safe webhook retry', async () => {
    await reserve(1, 'demo-failure');
    await pool.query(
      `CREATE FUNCTION fail_debit() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.delta<0 THEN RAISE EXCEPTION 'Synthetic debit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_debit BEFORE INSERT ON consultation_credit_ledger FOR EACH ROW EXECUTE FUNCTION fail_debit();`
    );
    await expect(
      settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-failure', 'completed')
    ).rejects.toThrow('Synthetic debit failure');
    expect(
      (await pool.query('SELECT state FROM doctor_consultation_credit_reservations')).rows[0].state
    ).toBe('reserved');
    expect(await balance()).toBe(2);
    await pool.query('DROP TRIGGER fail_debit ON consultation_credit_ledger');
    await settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-failure', 'completed');
    expect(await balance()).toBe(1);
  });
  test('late events cannot debit another patient or refund an already completed case', async () => {
    await reserve(1, 'demo-terminal');
    await settleConsultationCredit(pool, 2, 'demo-clinic', 'demo-terminal', 'completed');
    expect(await balance()).toBe(2);
    await settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-terminal', 'completed');
    await settleConsultationCredit(pool, 1, 'demo-clinic', 'demo-terminal', 'cancelled');
    expect(await balance()).toBe(1);
    expect(
      (await pool.query('SELECT state FROM doctor_consultation_credit_reservations')).rows[0].state
    ).toBe('consumed');
  });
  test('older cases created before this policy are not charged retroactively', async () => {
    await settleConsultationCredit(pool, 1, 'demo-clinic', 'legacy-case', 'completed');
    expect(await balance()).toBe(2);
    expect(
      (await pool.query('SELECT COUNT(*)::int n FROM doctor_consultation_credit_reservations'))
        .rows[0].n
    ).toBe(0);
  });
});
