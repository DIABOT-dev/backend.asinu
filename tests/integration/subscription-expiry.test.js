'use strict';

const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { databaseOptions } = require('../../src/lib/database-options');
jest.mock('../../src/lib/redis', () => ({ cacheDel: jest.fn(async () => {}) }));
const { cacheDel } = require('../../src/lib/redis');
const entitlement = require('../../src/services/payment/entitlement.service');
const household = require('../../src/services/payment/household.service');
const { lockPurchaseOwner } = require('../../src/services/payment/iap-revocation.service');

const describeDb = process.env.SUBSCRIPTION_TEST_DATABASE_URL ? describe : describe.skip;

describeDb('subscription expiry on isolated PostgreSQL tables', () => {
  const schema = 'subscription_expiry_' + randomBytes(6).toString('hex');
  const connection = process.env.SUBSCRIPTION_TEST_DATABASE_URL
    ? databaseOptions(process.env.SUBSCRIPTION_TEST_DATABASE_URL)
    : {};
  const admin = new Pool({ ...connection, max: 1 });
  let pool;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...connection, options: `-c search_path=${schema}`, max: 8 });
    await pool.query(`
      CREATE TABLE users (id integer PRIMARY KEY, display_name text, full_name text,
        email text, phone_number text, avatar_url text, deleted_at timestamptz);
      CREATE TABLE subscription_households (
        id bigserial PRIMARY KEY, owner_user_id integer NOT NULL UNIQUE REFERENCES users(id),
        plan_code text NOT NULL DEFAULT 'free', status text NOT NULL DEFAULT 'active',
        billing_period text, protected_member_limit integer NOT NULL DEFAULT 1,
        platform text, product_id text, original_transaction_id text,
        current_period_start timestamptz, current_period_end timestamptz,
        updated_at timestamptz DEFAULT NOW());
      CREATE TABLE subscription_household_members (
        id bigserial PRIMARY KEY, household_id bigint REFERENCES subscription_households(id),
        user_id integer REFERENCES users(id), added_by integer,
        status text NOT NULL DEFAULT 'active', added_at timestamptz DEFAULT NOW(), removed_at timestamptz,
        UNIQUE(household_id,user_id));
      CREATE UNIQUE INDEX one_active_household ON subscription_household_members(user_id) WHERE status='active';
      CREATE TABLE consultation_credit_ledger (household_id bigint, delta integer);
      CREATE TABLE user_connections (requester_id integer, addressee_id integer, status text);
    `);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await pool.query(
      'TRUNCATE users, subscription_households, subscription_household_members, consultation_credit_ledger, user_connections RESTART IDENTITY CASCADE'
    );
    await pool.query(
      "INSERT INTO users(id,display_name) VALUES (1,'Owner'),(2,'Member'),(3,'Second member')"
    );
    for (const id of [1, 2, 3]) await entitlement.ensureHousehold(pool, id);
    await pool.query(`UPDATE subscription_households SET plan_code='antam_4', protected_member_limit=4,
      billing_period='monthly', current_period_end=NOW()-INTERVAL '1 minute' WHERE owner_user_id=1`);
    await pool.query(
      "UPDATE subscription_household_members SET status='removed' WHERE user_id IN (2,3)"
    );
    await pool.query(`INSERT INTO subscription_household_members(household_id,user_id,added_by)
      SELECT h.id, u.id, 1 FROM subscription_households h CROSS JOIN users u
       WHERE h.owner_user_id=1 AND u.id IN (2,3)`);
    await pool.query("INSERT INTO user_connections VALUES (1,2,'accepted'),(1,3,'accepted')");
    await pool.query(
      'INSERT INTO consultation_credit_ledger(household_id,delta) SELECT id,4 FROM subscription_households WHERE owner_user_id=1'
    );
  });

  const owned = async () =>
    (await pool.query('SELECT * FROM subscription_households WHERE owner_user_id=1')).rows[0];
  const freeOwner = {
    planCode: 'free',
    protectedMemberLimit: 1,
    protectedMemberCount: 1,
    isOwner: true,
    isProtectedMember: true,
    callCenterEnabled: false,
    automaticEarlySignals: false,
  };

  test('an owner read automatically releases excess slots and both APIs return free 1/1', async () => {
    expect(await entitlement.getEntitlement(pool, 1)).toMatchObject(freeOwner);
    expect(await household.listProtectedMembers(pool, 1)).toMatchObject({
      planCode: 'free',
      protectedMemberLimit: 1,
      protectedMemberCount: 1,
      members: [{ userId: 1 }],
    });
    expect(await owned()).toMatchObject({
      plan_code: 'free',
      status: 'expired',
      protected_member_limit: 1,
    });
    const removed = await pool.query(
      'SELECT user_id,status FROM subscription_household_members WHERE household_id=$1 ORDER BY user_id',
      [(await owned()).id]
    );
    expect(removed.rows).toEqual([
      { user_id: 1, status: 'active' },
      { user_id: 2, status: 'removed' },
      { user_id: 3, status: 'removed' },
    ]);
    for (const userId of [1, 2, 3]) expect(cacheDel).toHaveBeenCalledWith(`subscription:${userId}`);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM user_connections WHERE status='accepted'"
        )
      ).rows[0].count
    ).toBe(2);
    expect(
      (await pool.query('SELECT SUM(delta)::int AS credits FROM consultation_credit_ledger'))
        .rows[0].credits
    ).toBe(4);
  });

  test('a former member reading first is returned to their own free household', async () => {
    expect(await entitlement.getEntitlement(pool, 2)).toMatchObject({
      ...freeOwner,
      ownerUserId: 2,
    });
    expect(await entitlement.getEntitlement(pool, 3)).toMatchObject({
      ...freeOwner,
      ownerUserId: 3,
    });
    expect(await entitlement.getEntitlement(pool, 1)).toMatchObject({
      ...freeOwner,
      ownerUserId: 1,
    });
  });

  test('opening the member list alone performs the same cleanup without a status request', async () => {
    expect(await household.listProtectedMembers(pool, 1)).toMatchObject({
      planCode: 'free',
      protectedMemberCount: 1,
      protectedMemberLimit: 1,
      members: [{ userId: 1 }],
    });
  });

  test('the scheduled sweep is idempotent and no webhook or app request is required', async () => {
    expect(await entitlement.expireDueSubscriptions(pool)).toEqual({ scanned: 1, expired: 1 });
    const timestamps = (
      await pool.query('SELECT removed_at FROM subscription_household_members ORDER BY id')
    ).rows;
    expect(await entitlement.expireDueSubscriptions(pool)).toEqual({ scanned: 0, expired: 0 });
    expect(
      (await pool.query('SELECT removed_at FROM subscription_household_members ORDER BY id')).rows
    ).toEqual(timestamps);
  });

  test('a member can join another paid household immediately after their former household expires', async () => {
    await pool.query("INSERT INTO users(id,display_name) VALUES (4,'New owner')");
    await entitlement.ensureHousehold(pool, 4);
    await pool.query(`UPDATE subscription_households SET plan_code='antam_2', protected_member_limit=2,
      billing_period='monthly', current_period_end=NOW()+INTERVAL '1 month' WHERE owner_user_id=4`);
    await pool.query("INSERT INTO user_connections VALUES (4,2,'accepted')");
    expect(await household.addProtectedMember(pool, 4, 2)).toMatchObject({
      planCode: 'antam_2',
      protectedMemberLimit: 2,
      protectedMemberCount: 2,
      members: [{ userId: 4 }, { userId: 2 }],
    });
    expect(await entitlement.getEntitlement(pool, 2)).toMatchObject({
      planCode: 'antam_2',
      ownerUserId: 4,
      isProtectedMember: true,
      callCenterEnabled: true,
    });
  });

  test('concurrent owner/member reads do not double-assign slots or return old family ownership', async () => {
    const results = await Promise.all(
      [1, 2, 3, 1, 2, 3].map((id) => entitlement.getEntitlement(pool, id))
    );
    results.forEach((result, i) =>
      expect(result).toMatchObject({ ...freeOwner, ownerUserId: [1, 2, 3][i % 3] })
    );
    const counts = await pool.query(
      "SELECT user_id, COUNT(*)::int AS count FROM subscription_household_members WHERE status='active' GROUP BY user_id ORDER BY user_id"
    );
    expect(counts.rows).toEqual([1, 2, 3].map((user_id) => ({ user_id, count: 1 })));
  });

  test('a renewal committed after the initial expired snapshot keeps the renewed plan and members', async () => {
    const stale = await owned();
    const renewal = await pool.connect();
    let reachedLock;
    const waiting = new Promise((resolve) => {
      reachedLock = resolve;
    });
    let result;
    try {
      await renewal.query('BEGIN');
      await lockPurchaseOwner(renewal, 1);
      await renewal.query(
        "UPDATE subscription_households SET current_period_end=NOW()+INTERVAL '1 month' WHERE owner_user_id=1"
      );
      const wrappedPool = {
        connect: async () => {
          const db = await pool.connect();
          return {
            release: () => db.release(),
            query: (sql, ...args) => {
              const pending = db.query(sql, ...args);
              if (sql.includes('pg_advisory_xact_lock')) reachedLock();
              return pending;
            },
          };
        },
        query: (...args) => pool.query(...args),
      };
      result = entitlement.reconcileExpiredHousehold(wrappedPool, stale);
      await waiting;
      await renewal.query('COMMIT');
      expect(await result).toBe(false);
    } finally {
      await renewal.query('ROLLBACK');
      renewal.release();
    }
    expect(await entitlement.getEntitlement(pool, 1)).toMatchObject({
      planCode: 'antam_4',
      protectedMemberCount: 3,
      isAnTam: true,
    });
    expect(cacheDel).not.toHaveBeenCalled();
  });

  test('cleanup inside a caller transaction never commits that transaction', async () => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      expect(await entitlement.getEntitlement(db, 1)).toMatchObject(freeOwner);
      expect((await owned()).plan_code).toBe('antam_4');
      await db.query('ROLLBACK');
    } finally {
      db.release();
    }
    expect((await owned()).plan_code).toBe('antam_4');
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM subscription_household_members WHERE household_id=$1 AND status='active'",
          [(await owned()).id]
        )
      ).rows[0].count
    ).toBe(3);
  });

  test('a failed slot release rolls back the whole downgrade and a retry succeeds', async () => {
    await pool.query(
      "ALTER TABLE subscription_household_members ADD CONSTRAINT expiry_failure CHECK (status='active') NOT VALID"
    );
    try {
      await expect(entitlement.getEntitlement(pool, 1)).rejects.toThrow('expiry_failure');
      expect((await owned()).plan_code).toBe('antam_4');
      expect(
        (
          await pool.query(
            "SELECT COUNT(*)::int AS count FROM subscription_household_members WHERE household_id=$1 AND status='active'",
            [(await owned()).id]
          )
        ).rows[0].count
      ).toBe(3);
      expect(cacheDel).not.toHaveBeenCalled();
    } finally {
      await pool.query('ALTER TABLE subscription_household_members DROP CONSTRAINT expiry_failure');
    }
    expect(await entitlement.getEntitlement(pool, 1)).toMatchObject(freeOwner);
  });
});
