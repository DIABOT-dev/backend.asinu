'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'gift-integration-not-for-runtime';
process.env.CRM_INTEGRATION_URL = 'http://integration.invalid/events';
process.env.CRM_INTEGRATION_SECRET = 'gift-integration-secret';
process.env.CRON_SECRET = 'gift-ops-test-secret';
const gifts = require('../../src/services/checkin-gifts/gift.service');
const giftAdmin = require('../../src/services/checkin-gifts/gift-admin.service');
const draw = require('../../src/services/checkin-gifts/draw.service');
const routes = require('../../src/routes/checkin-gifts.routes');
const ops = require('../../src/routes/checkin-gifts.ops.routes');
const describeDb = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDb('server-owned check-in gifts on isolated PostgreSQL tables', () => {
  const schema = 'gift_test_' + randomBytes(6).toString('hex');
  const admin = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  let pool, app;
  const tables = [
    'users',
    'user_onboarding_profiles',
    'subscription_households',
    'subscription_household_members',
    'consultation_credit_ledger',
    'health_checkins',
    'gift_config',
    'loc_items',
    'gift_draw_periods',
    'gift_events',
    'draw_tickets',
    'gift_family_outbox',
    'gift_draw_results',
    'gift_draw_result_outbox',
    'user_connections',
    'notifications',
    'notification_push_outbox',
    'user_baselines',
    'user_notification_preferences',
    'crm_event_outbox',
  ];
  const auth = (user) => ({
    Authorization:
      'Bearer ' +
      jwt.sign({ id: user, auth_version: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' }),
    'Accept-Language': 'vi',
  });
  async function fixture(status = 'fine') {
    const user = (
      await pool.query(
        'INSERT INTO users (phone_number,display_name) VALUES ($1,$2) RETURNING id',
        ['gift-' + randomBytes(6).toString('hex'), 'Gift fixture']
      )
    ).rows[0].id;
    const session = (
      await pool.query(
        "INSERT INTO health_checkins (user_id,session_date,initial_status,current_status,flow_state) VALUES ($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,$2,$2,'monitoring') RETURNING *",
        [user, status]
      )
    ).rows[0];
    return { user, session };
  }
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of tables)
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    pool = new Pool({
      connectionString: process.env.CHECKIN_TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
      max: 25,
    });
    await pool.query('INSERT INTO gift_config SELECT * FROM public.gift_config');
    await pool.query('INSERT INTO loc_items SELECT * FROM public.loc_items');
    app = express();
    app.locals.authPool = pool;
    app.use(express.json());
    app.use('/gift', routes(pool));
    app.use('/ops', ops(pool));
    app.get('/draw-results/:id', draw.publicPage(pool));
  });
  afterAll(async () => {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query('UPDATE gift_draw_periods SET active=FALSE');
    await pool.query(
      'UPDATE gift_config SET enabled=TRUE,lucky_draw_enabled=FALSE,loc_weight=60,ticket_weight=30,coupon_weight=10 WHERE id=1'
    );
  });

  test('all API routes require auth; admin content/config is also protected', async () => {
    await request(app).get('/gift/today').expect(401);
    await request(app).post('/gift/open').send({}).expect(401);
    await request(app).get('/ops/config').expect(401);
  });
  test('the variety migration adds proverbs and inactive tip drafts without replacing saved gifts or edited content', async () => {
    const f = await fixture();
    const saved = await gifts.assign(pool, f.user, f.session);
    const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/115_gift_fortune_variety.sql'), 'utf8');
    await pool.query(migration);
    const proverb = (await pool.query("SELECT * FROM loc_items WHERE code='proverb_01'")).rows[0];
    expect(proverb).toMatchObject({ type: 'proverb', active: true, serif: true });
    const drafts = (await pool.query("SELECT * FROM loc_items WHERE code LIKE 'tip_draft_%'")).rows;
    expect(drafts).toHaveLength(12);
    expect(drafts.every(item => item.type === 'health_tip' && !item.active && !item.reviewed_by && !item.reviewed_at)).toBe(true);
    await pool.query("UPDATE loc_items SET text='Operator-reviewed wording' WHERE code='proverb_01'");
    await pool.query(migration);
    expect((await pool.query("SELECT text FROM loc_items WHERE code='proverb_01'")).rows[0].text).toBe('Operator-reviewed wording');
    expect((await pool.query("SELECT count(*)::int n FROM loc_items WHERE code LIKE 'proverb_%'")).rows[0].n).toBe(20);
    expect((await gifts.assign(pool, f.user, f.session)).loc_snapshot).toEqual(saved.loc_snapshot);
    await pool.query("UPDATE loc_items SET text=$1 WHERE code='proverb_01'", [proverb.text]);
  });
  test('the pause migration keeps ticket issuance at zero without removing fortunes', async () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../../db/migrations/113_pause_gift_draws.sql'),
      'utf8'
    );
    await pool.query(migration);
    const config = (await pool.query('SELECT * FROM gift_config WHERE id=1')).rows[0];
    expect(config.ticket_weight).toBe(0);
    expect(config.lucky_draw_enabled).toBe(false);
    expect(config.loc_weight + config.coupon_weight).toBe(100);
    await pool.query(migration);
    expect(
      (await pool.query('SELECT loc_weight FROM gift_config WHERE id=1')).rows[0].loc_weight
    ).toBe(config.loc_weight);
    const f = await fixture();
    expect((await gifts.assign(pool, f.user, f.session)).extra).toBe('none');
  });
  test('a check-in earns exactly one immutable result across 30 parallel requests', async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => gifts.assign(pool, f.user, f.session))
    );
    expect(new Set(results.map((x) => x.id)).size).toBe(1);
    const day = await gifts.today(pool, f.user, 'vi');
    expect(day.gift.loc).toBe(null);
    expect(day.gift.extra).toBe(null);
    expect(day.streak).toBe(1);
    const publicDay = (
      await pool.query("SELECT (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day")
    ).rows[0].day;
    expect(day.gift.day).toBe(publicDay);
    expect(day.week.filter((x) => x.checked)).toHaveLength(1);
  });
  test('all status answers and paid/free households get a daily fortune with no coupon leakage', async () => {
    for (const status of ['fine', 'tired', 'very_tired', 'specific_concern']) {
      const f = await fixture(status),
        g = await gifts.assign(pool, f.user, f.session);
      expect(g.extra).toBe('none');
      expect(g.answer).toBe(status);
      const opened = await gifts.open(pool, f.user, g.id, 2, 'vi');
      expect(opened.loc.text).toBeTruthy();
      expect(JSON.stringify(opened)).not.toMatch(/value_vnd|store_code|1199000|100000/);
    }
  });
  test('two members of one household share the same daily result', async () => {
    const a = await fixture(),
      b = await fixture('tired');
    const household = await gifts.householdFor(pool, a.user);
    await pool.query(
      'INSERT INTO subscription_household_members (household_id,user_id,added_by) VALUES ($1,$2,$3)',
      [household.id, b.user, a.user]
    );
    await pool.query(
      "UPDATE subscription_households SET plan_code='antam_2',current_period_end=NOW()+INTERVAL '30 days' WHERE id=$1",
      [household.id]
    );
    const received = await Promise.all([
      gifts.assign(pool, a.user, a.session),
      gifts.assign(pool, b.user, b.session),
    ]);
    expect(received[0].id).toBe(received[1].id);
    expect(
      (await pool.query('SELECT count(*) FROM gift_events WHERE household_id=$1', [household.id]))
        .rows[0].count
    ).toBe('1');
  });
  test('opening retries keep the first box/result and one CRM event; other households cannot read or claim it', async () => {
    const a = await fixture(),
      b = await fixture(),
      g = await gifts.assign(pool, a.user, a.session);
    const first = await gifts.open(pool, a.user, g.id, 0, 'vi');
    const repeat = await gifts.open(pool, a.user, g.id, 5, 'vi');
    expect(repeat).toEqual(first);
    expect(repeat.box).toBe(0);
    const crm = await pool.query('SELECT count(*) FROM crm_event_outbox WHERE event_id=$1', [
      'gift.opened:' + g.id,
    ]);
    expect(crm.rows[0].count).toBe('1');
    await request(app)
      .post('/gift/open')
      .set(auth(b.user))
      .send({ gift_id: g.id, box: 1 })
      .expect(404);
    const history = await request(app).get('/gift/history').set(auth(b.user)).expect(200);
    expect(history.body.items).toEqual([]);
    const own = await request(app).get('/gift/history').set(auth(a.user)).expect(200);
    expect(own.body.items[0].loc.text).toBe(first.loc.text);
  });
  test('daily gifts are recovered from a committed call check-in when the app opens', async () => {
    const f = await fixture('very_tired');
    await pool.query("UPDATE health_checkins SET occurrence_source='checkin_call' WHERE id=$1", [
      f.session.id,
    ]);
    const r = await request(app).get('/gift/today').set(auth(f.user)).expect(200);
    expect(r.body.gift).toBeTruthy();
    expect(r.body.offerOnAppOpen).toBe(true);
    expect(r.body.checkinStatus).toBe('very_tired');
    expect(r.headers['cache-control']).toContain('no-store');
  });
  test('fortunes used in the last 30 days are excluded, including under changed weights', async () => {
    const f = await fixture(),
      household = await gifts.householdFor(pool, f.user);
    const locs = (await pool.query('SELECT * FROM loc_items ORDER BY id LIMIT 29')).rows;
    for (let i = 0; i < locs.length; i++)
      await pool.query(
        "INSERT INTO gift_events (id,household_id,user_id,date_vn,loc_id,loc_snapshot,extra,answer,random_value,config_snapshot) VALUES ($1,$2,$3,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-$4::integer,$5,$6,'none','fine',0,'{}')",
        [randomUUID(), household.id, f.user, i + 1, locs[i].id, JSON.stringify(locs[i])]
      );
    const g = await gifts.assign(pool, f.user, f.session);
    expect(locs.map((x) => x.id)).not.toContain(g.loc_id);
    const day = await gifts.today(pool, f.user, 'vi');
    expect(day.streak).toBe(30);
  });
  test('gift recovery uses the response calendar day even when health monitoring still belongs to yesterday', async () => {
    const f = await fixture();
    await pool.query(
      "UPDATE health_checkins SET session_date=session_date-1,last_response_at=NOW(),occurrence_source='checkin_call' WHERE id=$1",
      [f.session.id]
    );
    const result = await gifts.today(pool, f.user, 'vi');
    expect(result.gift).toBeTruthy();
    expect(result.offerOnAppOpen).toBe(true);
    expect(result.gift.day).toBe(
      (await pool.query("SELECT (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day"))
        .rows[0].day
    );
  });
  test('the streak keeps real check-ins made before gift assignment was enabled', async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO health_checkins (user_id,session_date,initial_status,current_status,flow_state,last_response_at) VALUES ($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-1,'fine','fine','monitoring',NOW()-INTERVAL '1 day')",
      [f.user]
    );
    expect((await gifts.today(pool, f.user, 'vi')).streak).toBe(2);
  });
  test('gift errors inside a call transaction roll back to a savepoint and leave health data writable', async () => {
    const f = await fixture();
    const db = await pool.connect();
    await db.query('BEGIN');
    try {
      const wrapped = {
        release() {},
        query: (sql, args) =>
          sql.includes('FROM gift_config')
            ? db.query('SELECT * FROM gift_table_intentionally_missing')
            : db.query(sql, args),
      };
      expect(await gifts.safeAssign(wrapped, f.user, f.session)).toBe(null);
      expect(
        (await db.query('SELECT id FROM health_checkins WHERE id=$1', [f.session.id])).rowCount
      ).toBe(1);
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });
  test('flags fold tickets to fortunes; enabling a draw requires a configured, registered, open period', async () => {
    await pool.query(
      'UPDATE gift_config SET loc_weight=0,ticket_weight=100,coupon_weight=0 WHERE id=1'
    );
    const a = await fixture();
    expect((await gifts.assign(pool, a.user, a.session)).extra).toBe('none');
    const now = new Date(Date.now() + 7 * 3600000);
    const monthEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 7 * 3600000 - 1000
    );
    await pool.query(
      "INSERT INTO gift_draw_periods (code,prize_name,starts_at,closes_at,draw_at,rules,registration_reference,active) VALUES ('TEST','Fixture chair',date_trunc('month',NOW()),$1,$2,$3,'TEST-ONLY',TRUE)",
      [
        new Date(monthEnd - 1000),
        monthEnd,
        JSON.stringify({ vi: 'Thể lệ kiểm thử', en: 'Test rules' }),
      ]
    );
    await pool.query('UPDATE gift_config SET lucky_draw_enabled=TRUE WHERE id=1');
    const b = await fixture(),
      g = await gifts.assign(pool, b.user, b.session);
    expect(g.extra).toBe('ticket');
    const opened = await gifts.open(pool, b.user, g.id, 1, 'vi');
    expect(opened.ticket.number).toMatch(/^A\d+$/);
    const rules = await request(app)
      .get(`/gift/draw/${opened.ticket.periodId}/rules`)
      .set(auth(b.user))
      .expect(200);
    expect(rules.body.rules).toBe('Thể lệ kiểm thử');
    await pool.query('UPDATE gift_config SET lucky_draw_enabled=FALSE WHERE id=1');
    await request(app)
      .get(`/gift/draw/${opened.ticket.periodId}/rules`)
      .set(auth(b.user))
      .expect(404);
  });
  test('bad request values and impossible dates never create or reveal rewards', async () => {
    const f = await fixture();
    for (const box of [-1, 6, '1', null])
      await request(app)
        .post('/gift/open')
        .set(auth(f.user))
        .send({ gift_id: randomUUID(), box })
        .expect(400);
    await request(app).get('/gift/history?before=2026-02-31').set(auth(f.user)).expect(400);
  });
  test('care-circle receipts require current alert permission and remain read-only for the caregiver', async () => {
    const mother = await fixture(),
      child = await fixture(),
      stranger = await fixture();
    const g = await gifts.assign(pool, mother.user, mother.session);
    await pool.query(
      "INSERT INTO user_connections (requester_id,addressee_id,status,permissions) VALUES ($1,$2,'accepted',$3)",
      [mother.user, child.user, JSON.stringify({ can_receive_alerts: true })]
    );
    await request(app).get(`/gift/${g.id}`).set(auth(child.user)).expect(404);
    await gifts.open(pool, mother.user, g.id, 1, 'vi');
    await request(app).get(`/gift/${g.id}`).set(auth(child.user)).expect(200);
    await request(app).get(`/gift/${g.id}`).set(auth(stranger.user)).expect(404);
    await request(app)
      .post('/gift/open')
      .set(auth(child.user))
      .send({ gift_id: g.id, box: 3 })
      .expect(404);
    await pool.query(
      "UPDATE user_connections SET permissions='{}' WHERE requester_id=$1 AND addressee_id=$2",
      [mother.user, child.user]
    );
    await request(app).get(`/gift/${g.id}`).set(auth(child.user)).expect(404);
    await gifts.deliverFamilyEvents(pool);
    expect(
      (
        await pool.query('SELECT cancelled_at FROM gift_family_outbox WHERE gift_event_id=$1', [
          g.id,
        ])
      ).rows[0].cancelled_at
    ).toBeTruthy();
  });
  test('family notifications persist once through concurrent retries without contacting any push provider', async () => {
    const mother = await fixture(),
      child = await fixture();
    await pool.query(
      "INSERT INTO user_connections (requester_id,addressee_id,status,permissions) VALUES ($1,$2,'accepted',$3)",
      [mother.user, child.user, JSON.stringify({ can_receive_alerts: true })]
    );
    const g = await gifts.assign(pool, mother.user, mother.session);
    await gifts.open(pool, mother.user, g.id, 2, 'vi');
    await Promise.all([gifts.deliverFamilyEvents(pool), gifts.deliverFamilyEvents(pool)]);
    await gifts.deliverFamilyEvents(pool);
    const notices = (
      await pool.query(
        "SELECT id,data FROM notifications WHERE user_id=$1 AND type='gift_opened'",
        [child.user]
      )
    ).rows;
    expect(notices).toHaveLength(1);
    expect(notices[0].data.giftId).toBe(g.id);
    expect(
      (
        await pool.query('SELECT state FROM notification_push_outbox WHERE notification_id=$1', [
          notices[0].id,
        ])
      ).rows[0].state
    ).toBe('CANCELLED');
    const crm = (
      await pool.query('SELECT payload FROM crm_event_outbox WHERE event_id=$1', [
        'gift.opened:' + g.id,
      ])
    ).rows[0];
    expect(JSON.stringify(crm.payload)).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  test('moving to another household neither rerolls the daily gift nor loses the original receipt', async () => {
    const a = await fixture(),
      b = await fixture();
    const g = await gifts.assign(pool, a.user, a.session);
    await gifts.open(pool, a.user, g.id, 4, 'vi');
    const household = await gifts.householdFor(pool, b.user);
    await pool.query(
      "UPDATE subscription_households SET plan_code='antam_2',current_period_end=NOW()+INTERVAL '30 days' WHERE id=$1",
      [household.id]
    );
    await pool.query(
      'UPDATE subscription_household_members SET household_id=$1,added_by=$3 WHERE user_id=$2',
      [household.id, a.user, b.user]
    );
    expect((await gifts.assign(pool, a.user, a.session)).id).toBe(g.id);
    expect((await gifts.today(pool, a.user, 'vi')).gift.id).toBe(g.id);
    expect((await gifts.history(pool, a.user, null, 'vi')).items[0].id).toBe(g.id);
  });
  test('expired unopened gifts cannot be opened, while committed receipts remain readable', async () => {
    const a = await fixture(),
      b = await fixture();
    const unopened = await gifts.assign(pool, a.user, a.session),
      opened = await gifts.assign(pool, b.user, b.session);
    await gifts.open(pool, b.user, opened.id, 0, 'vi');
    await pool.query('UPDATE gift_events SET date_vn=date_vn-1 WHERE id=ANY($1::uuid[])', [
      [unopened.id, opened.id],
    ]);
    await expect(gifts.open(pool, a.user, unopened.id, 0, 'vi')).rejects.toMatchObject({
      code: 'GIFT_DAY_ENDED',
    });
    expect((await gifts.open(pool, b.user, opened.id, 5, 'vi')).box).toBe(0);
  });
  test('content ops reject unreviewed medical tips, invalid probabilities and enabling deferred coupons', async () => {
    const tip = {
      type: 'health_tip',
      text: 'Nội dung kiểm thử',
      text_en: 'Test content',
      conditions: [],
      serif: false,
      active: true,
      reviewed_by: null,
    };
    await request(app)
      .put('/ops/loc-items/test_tip')
      .set('x-cron-secret', process.env.CRON_SECRET)
      .send(tip)
      .expect(400);
    await request(app)
      .put('/ops/loc-items/test_tip')
      .set('x-cron-secret', process.env.CRON_SECRET)
      .send({ ...tip, reviewed_by: 'Test medical reviewer' })
      .expect(200);
    const c = (await pool.query('SELECT * FROM gift_config WHERE id=1')).rows[0];
    const body = {
      enabled: true,
      loc_weight: 60,
      ticket_weight: 30,
      coupon_weight: 10,
      lucky_draw_enabled: false,
      coupon_enabled: false,
      coupon_max_vnd: 100000,
    };
    await request(app)
      .put('/ops/config')
      .set('x-cron-secret', process.env.CRON_SECRET)
      .send({ ...body, loc_weight: 61 })
      .expect(400);
    await request(app)
      .put('/ops/config')
      .set('x-cron-secret', process.env.CRON_SECRET)
      .send({ ...body, coupon_enabled: true })
      .expect(400);
    expect((await pool.query('SELECT * FROM gift_config WHERE id=1')).rows[0]).toEqual(c);
  });
  test('closed draws freeze their list, publish idempotently and expose only escaped public ticket numbers', async () => {
    const a = await fixture(),
      g = await gifts.assign(pool, a.user, a.session);
    const period = (
      await pool.query(
        "INSERT INTO gift_draw_periods (code,prize_name,starts_at,closes_at,draw_at,rules,registration_reference) VALUES ('CLOSED','<script>fixture</script>',NOW()-INTERVAL '4 days',NOW()-INTERVAL '2 days',NOW()-INTERVAL '1 day',$1,'TEST-ONLY') RETURNING *",
        [
          JSON.stringify({
            vi: 'Thể lệ chỉ dành cho kiểm thử.',
            en: 'Rules used only for an isolated integration test.',
          }),
        ]
      )
    ).rows[0];
    const ticket = (
      await pool.query(
        'INSERT INTO draw_tickets (household_id,draw_period,gift_event_id) VALUES ($1,$2,$3) RETURNING ticket_no',
        [g.household_id, period.id, g.id]
      )
    ).rows[0].ticket_no;
    await pool.query('UPDATE gift_config SET lucky_draw_enabled=TRUE WHERE id=1');
    await expect(draw.publish(pool, period.id, [ticket])).rejects.toMatchObject({
      code: 'DRAW_NOT_READY',
    });
    const csv = await giftAdmin.exportTickets(pool, String(period.id));
    expect(csv).toContain(ticket);
    expect(csv).not.toMatch(/phone|display_name|gift-/);
    const updated = {
      prize_name: 'Changed prize',
      starts_at: period.starts_at.toISOString(),
      closes_at: new Date(
        Date.parse(
          new Date(period.draw_at.getTime() + 7 * 3600000).toISOString().slice(0, 10) +
            'T00:00:00+07:00'
        ) - 60000
      ).toISOString(),
      draw_at: period.draw_at.toISOString(),
      rules: {
        vi: 'Thể lệ dành riêng cho kỳ quay kiểm thử này.',
        en: 'Rules used only for an isolated integration test.',
      },
      registration_reference: 'TEST-ONLY',
      active: true,
    };
    await expect(giftAdmin.saveDraw(pool, 'CLOSED', updated)).rejects.toMatchObject({
      code: 'DRAW_ALREADY_HAS_TICKETS',
    });
    expect(await draw.publish(pool, period.id, [ticket])).toEqual({ published: 1 });
    await draw.publish(pool, period.id, [ticket]);
    await expect(draw.publish(pool, period.id, ['A999999999999'])).rejects.toMatchObject({
      code: 'DRAW_ALREADY_PUBLISHED',
    });
    expect(
      (
        await pool.query('SELECT count(*) FROM gift_draw_result_outbox WHERE draw_period=$1', [
          period.id,
        ])
      ).rows[0].count
    ).toBe('1');
    const result = await request(app).get(`/draw-results/${period.id}`).expect(200);
    expect(result.text).toContain('&lt;script&gt;fixture&lt;/script&gt;');
    expect(result.text).not.toContain('<script>');
    expect(result.text).toContain(ticket);
    expect(result.text).not.toMatch(/household_id|phone_number|Gift fixture/);
    await pool.query('UPDATE gift_config SET lucky_draw_enabled=FALSE WHERE id=1');
    await request(app).get(`/draw-results/${period.id}`).expect(404);
    await draw.deliverResults(pool);
    expect(
      (
        await pool.query(
          'SELECT notification_id FROM gift_draw_result_outbox WHERE draw_period=$1',
          [period.id]
        )
      ).rows[0].notification_id
    ).toBe(null);
    await pool.query('UPDATE gift_config SET lucky_draw_enabled=TRUE WHERE id=1');
    await Promise.all([draw.deliverResults(pool), draw.deliverResults(pool)]);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM notifications WHERE user_id=$1 AND type='gift_draw_result'",
          [a.user]
        )
      ).rows[0].count
    ).toBe('1');
  });
});
