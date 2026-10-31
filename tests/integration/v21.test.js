'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg'),
  request = require('supertest'),
  express = require('express'),
  jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'v21-integration-not-a-runtime-secret';
process.env.KEY_MANAGEMENT_PROVIDER = 'file';
process.env.HEALTH_FIELD_ENCRYPTION_ENABLED = 'true';
const keys = fs.mkdtempSync(path.join(os.tmpdir(), 'asinu-v21-test-keys-'));
fs.chmodSync(keys, 0o700);
process.env.HEALTH_FIELD_KEY_DIRECTORY = keys;
jest.mock('../../src/lib/redis', () => ({
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => {}),
  cacheDel: jest.fn(async () => {}),
}));
jest.mock('../../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest.fn(async () => [{ status: 'ok' }]),
}));
jest.mock('../../src/services/notification/fcm.notification.service', () => ({
  sendFcmNotification: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../src/services/notification/apns.voip.service', () => ({
  sendVoipNotification: jest.fn(async () => ({ ok: true })),
}));
const c = require('../../src/services/v21/common'),
  coins = require('../../src/services/v21/coins.service'),
  med = require('../../src/services/v21/medication.service'),
  calls = require('../../src/services/v21/medication-calls.service');
const scan = require('../../src/services/v21/medication-scan.service'),
  maintenance = require('../../src/services/v21/maintenance.service'),
  messages = require('../../src/services/v21/messages.service');
const source = fs.readFileSync(
  path.join(__dirname, '../../db/migrations/123_medication_and_coins.sql'),
  'utf8'
);
const describeDb = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;
describeDb('V2.1 on isolated real PostgreSQL tables', () => {
  jest.setTimeout(30000);
  const schema = 'v21_test_' + randomBytes(5).toString('hex');
  const admin = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  let db, app;
  const newlyCreated = new Set([...source.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]));
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'"))
      .rows;
    for (const { tablename: table } of tables) {
      if (newlyCreated.has(table)) continue;
      await admin.query(`CREATE TABLE ${schema}."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      const columns = (
        await admin.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_default LIKE 'nextval(%'",
          [table]
        )
      ).rows;
      for (const { column_name: column } of columns) {
        const seq = `${table}_${column}_v21_seq`;
        await admin.query(
          `CREATE SEQUENCE ${schema}."${seq}" OWNED BY ${schema}."${table}"."${column}"`
        );
        await admin.query(
          `ALTER TABLE ${schema}."${table}" ALTER COLUMN "${column}" SET DEFAULT nextval('${schema}."${seq}"')`
        );
      }
    }
    db = new Pool({
      connectionString: process.env.CHECKIN_TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
      max: 20,
    });
    await db.query(
      'ALTER TABLE draw_tickets DROP COLUMN IF EXISTS user_id,DROP COLUMN IF EXISTS source,DROP COLUMN IF EXISTS redemption_id'
    );
    await db.query(source);
    await db.query(
      fs.readFileSync(
        path.join(__dirname, '../../db/migrations/124_medication_receipt_audit_id.sql'),
        'utf8'
      )
    );
    await db.query('INSERT INTO gift_config SELECT * FROM public.gift_config');
    await db.query('INSERT INTO loc_items SELECT * FROM public.loc_items');
    await db.query(`CREATE SEQUENCE IF NOT EXISTS ${schema}.gift_ticket_numbers`);
    await db.query(
      `ALTER TABLE draw_tickets ALTER COLUMN ticket_no SET DEFAULT ('A'||nextval('${schema}.gift_ticket_numbers')::text)`
    );
    app = express();
    app.locals.authPool = db;
    app.use(express.json());
    app.use('/api/mobile', require('../../src/routes/v21.routes')(db));
  });
  afterAll(async () => {
    if (db) await db.end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.end();
    fs.rmSync(keys, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.query(
      'UPDATE v21_config SET medication_enabled=TRUE,coins_enabled=TRUE,scan_enabled=TRUE,native_call_enabled=FALSE,rollout_user_ids=ARRAY[]::integer[]'
    );
  });
  async function user() {
    const id = (
      await db.query(
        'INSERT INTO users(phone_number,display_name,push_token) VALUES($1,$2,$3) RETURNING id',
        ['v21-' + randomBytes(8).toString('hex'), 'V2.1 fixture', 'ExponentPushToken[fixture]']
      )
    ).rows[0].id;
    await db.query(
      'INSERT INTO user_notification_preferences(user_id,reminders_enabled) VALUES($1,TRUE)',
      [id]
    );
    return id;
  }
  async function connect(a, b) {
    await db.query(
      "INSERT INTO user_connections(requester_id,addressee_id,status,permissions) VALUES($1,$2,'accepted',$3)",
      [a, b, JSON.stringify({ can_receive_alerts: true, can_view_logs: true })]
    );
  }
  const auth = (id) => ({
    Authorization:
      'Bearer ' + jwt.sign({ id, auth_version: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' }),
  });
  async function item(id, kind = 'MEDICINE') {
    return (
      await med.createItem(db, id, id, {
        display_name: kind === 'MEDICINE' ? 'Thuốc huyết áp' : 'Vitamin D3',
        kind,
        source: 'CHIP',
        confirmed: true,
      })
    ).item;
  }
  async function dose(id, { kind = 'MEDICINE', minutes = -10, time = '07:00' } = {}) {
    const i = await item(id, kind),
      s = (await med.saveSchedule(db, id, id, null, { time_local: time, item_ids: [i.id] }))
        .schedule;
    const e = (
      await db.query(
        `INSERT INTO med_dose_events(id,schedule_id,patient_user_id,local_date,scheduled_at,next_attempt_at,timezone,has_medicine)
   VALUES($1,$2,$3,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,NOW()+($4*INTERVAL '1 minute'),NOW(), 'Asia/Ho_Chi_Minh',$5) RETURNING *`,
        [randomUUID(), s.id, id, minutes, kind === 'MEDICINE']
      )
    ).rows[0];
    await db.query(
      'INSERT INTO med_dose_items(dose_event_id,item_id,display_name,kind,patient_user_id) VALUES($1,$2,$3,$4,$5)',
      [e.id, i.id, med.protect(id, 'med_dose_items.display_name', i.display_name), kind, id]
    );
    return e;
  }
  async function seedCoins(id, n = 500) {
    await c.transaction(db, async (tx) => {
      await c.balanceLock(tx, id);
      const l = (
        await tx.query(
          "INSERT INTO coin_ledger(user_id,delta,reason,ref_id,local_date,expires_at) VALUES($1,$2,'REFUND',$3,CURRENT_DATE,NOW()+INTERVAL '12 months') RETURNING id",
          [id, n, randomUUID()]
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO coin_lots(ledger_id,user_id,remaining,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '12 months')",
        [l.id, id, n]
      );
      await tx.query('UPDATE coin_balances SET balance=$2 WHERE user_id=$1', [id, n]);
    });
  }
  test('new account has no schedules, doses or calls; APIs still require auth', async () => {
    const id = await user();
    expect((await med.overview(db, id, id)).schedules).toEqual([]);
    await calls.prepare(db);
    expect(
      (await db.query('SELECT count(*)::int n FROM med_dose_events WHERE patient_user_id=$1', [id]))
        .rows[0].n
    ).toBe(0);
    await request(app).get('/api/mobile/coins/today').expect(401);
  });
  test('remote schedule is pending until its patient accepts; a different user cannot consent', async () => {
    const parent = await user(),
      child = await user(),
      other = await user();
    await connect(parent, child);
    const i = await item(parent);
    const s = (
      await med.saveSchedule(db, child, parent, null, { time_local: '07:30', item_ids: [i.id] })
    ).schedule;
    expect(s.consent_state).toBe('PENDING');
    await calls.prepare(db);
    expect(
      (await db.query('SELECT 1 FROM med_dose_events WHERE schedule_id=$1', [s.id])).rowCount
    ).toBe(0);
    await request(app)
      .post(`/api/mobile/med-schedules/${s.id}/consent`)
      .set(auth(other))
      .send({ accept: true })
      .expect(404);
    await med.consent(db, parent, s.id, true);
    await calls.prepare(db);
    expect(
      (await db.query('SELECT 1 FROM med_dose_events WHERE schedule_id=$1', [s.id])).rowCount
    ).toBe(1);
  });
  test('a stranger cannot read or set patient items/schedules', async () => {
    const parent = await user(),
      stranger = await user();
    await expect(med.overview(db, stranger, parent)).rejects.toMatchObject({ statusCode: 403 });
    await request(app)
      .post('/api/mobile/med-items?patientId=' + parent)
      .set(auth(stranger))
      .send({ display_name: 'Private', kind: 'MEDICINE', source: 'CHIP', confirmed: true })
      .expect(403);
  });
  test('schedule and item names are encrypted, but owner API returns readable names', async () => {
    const id = await user(),
      i = await item(id);
    const stored = (await db.query('SELECT display_name FROM med_items WHERE id=$1', [i.id]))
      .rows[0].display_name;
    expect(stored).toMatch(/^asinu:enc:v1:/);
    expect((await med.overview(db, id, id)).items[0].display_name).toBe('Thuốc huyết áp');
  });
  test('maximum four enabled daily schedules is enforced', async () => {
    const id = await user(),
      i = await item(id);
    for (const time of ['07:00', '11:00', '18:00', '20:00'])
      await med.saveSchedule(db, id, id, null, { time_local: time, item_ids: [i.id] });
    await expect(
      med.saveSchedule(db, id, id, null, { time_local: '21:30', item_ids: [i.id] })
    ).rejects.toMatchObject({ code: 'MED_SCHEDULE_LIMIT' });
  });
  test.each([
    [1, 'TAKEN'],
    [2, 'SKIPPED'],
    [3, 'OUT_OF_MEDS'],
  ])('answer %s sets %s and awards equal coins once', async (button, state) => {
    const id = await user(),
      e = await dose(id);
    const request_id = randomUUID();
    const outputs = await Promise.all(
      Array.from({ length: 10 }, () => calls.answer(db, id, e.id, { button, request_id }))
    );
    expect(outputs[0].event.state).toBe(state);
    await coins.processEvents(db, 100, id);
    expect((await coins.today(db, id)).balance).toBe(5);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM logs_common WHERE user_id=$1 AND log_type='medication'",
          [id]
        )
      ).rows[0].n
    ).toBe(button === 1 ? 1 : 0);
    await calls.queueDue(db);
    expect(
      (await db.query('SELECT 1 FROM med_call_attempts WHERE dose_event_id=$1', [e.id])).rowCount
    ).toBe(0);
  });
  test('changing a request id payload cannot change the recorded answer', async () => {
    const id = await user(),
      e = await dose(id),
      request_id = randomUUID();
    await calls.answer(db, id, e.id, { button: 2, request_id });
    await expect(calls.answer(db, id, e.id, { button: 1, request_id })).rejects.toMatchObject({
      code: 'MED_REQUEST_CHANGED',
    });
  });
  test('a future dose cannot be marked taken to collect coins early', async () => {
    const id = await user(),
      e = await dose(id, { minutes: 120 });
    await expect(
      calls.answer(db, id, e.id, { button: 1, request_id: randomUUID() })
    ).rejects.toMatchObject({ code: 'MED_DOSE_NOT_DUE' });
  });
  test('two missed attempts finish as unconfirmed, including after restart/repeated ticks', async () => {
    const id = await user(),
      e = await dose(id);
    await calls.queueDue(db);
    for (let i = 0; i < 2; i++) {
      await db.query(
        "UPDATE med_call_attempts SET deadline=NOW()-INTERVAL '1 second' WHERE dose_event_id=$1",
        [e.id]
      );
      await calls.closeTimeouts(db);
      await db.query('UPDATE med_dose_events SET next_attempt_at=NOW() WHERE id=$1', [e.id]);
      if (!i) await calls.queueDue(db);
    }
    await calls.queueDue(db);
    const current = (await db.query('SELECT * FROM med_dose_events WHERE id=$1', [e.id])).rows[0];
    expect(current.state).toBe('UNCONFIRMED');
    expect(current.attempt_count).toBe(2);
    expect(
      (
        await db.query('SELECT count(*)::int n FROM med_call_attempts WHERE dose_event_id=$1', [
          e.id,
        ])
      ).rows[0].n
    ).toBe(2);
  });
  test('late answer within two hours is accepted; later answer does not create a taken record', async () => {
    const id = await user(),
      e = await dose(id);
    await db.query("UPDATE med_dose_events SET state='UNCONFIRMED',attempt_count=2 WHERE id=$1", [
      e.id,
    ]);
    expect(
      (await calls.answer(db, id, e.id, { button: 1, request_id: randomUUID() })).event.state
    ).toBe('TAKEN');
    const other = await dose(id, { minutes: -130, time: '19:00' });
    expect(
      (await calls.answer(db, id, other.id, { button: 1, request_id: randomUUID() }))
        .answerWindowClosed
    ).toBe(true);
  });
  test('supplements are excluded from medicine adherence and tookMedicationToday logs', async () => {
    const id = await user(),
      e = await dose(id, { kind: 'SUPPLEMENT' });
    await calls.answer(db, id, e.id, { button: 1, request_id: randomUUID() });
    expect(
      (await db.query('SELECT 1 FROM medication_adherence WHERE user_id=$1', [id])).rowCount
    ).toBe(0);
    expect(
      (await db.query("SELECT 1 FROM logs_common WHERE user_id=$1 AND log_type='medication'", [id]))
        .rowCount
    ).toBe(0);
  });
  test('duplicate event and deleting a vital log cannot bypass the daily two-create cap', async () => {
    const id = await user();
    for (let i = 0; i < 5; i++) {
      const log = randomUUID();
      await db.query(
        "INSERT INTO logs_common(id,user_id,log_type,occurred_at) VALUES($1,$2,'bp',NOW())",
        [log, id]
      );
      await db.query('DELETE FROM logs_common WHERE id=$1', [log]);
    }
    await coins.processEvents(db, 100, id);
    expect((await coins.today(db, id)).balance).toBe(10);
  });
  test('all default daily tasks award exactly 42, then stop', async () => {
    const id = await user();
    await db.query(
      "INSERT INTO health_checkins(user_id,session_date,initial_status,current_status,flow_state,last_response_at) VALUES($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'very_tired','very_tired','high_alert',NOW())",
      [id]
    );
    for (let i = 0; i < 4; i++) {
      const e = await dose(id, { time: ['07:00', '11:00', '17:00', '20:00'][i] });
      await calls.answer(db, id, e.id, { button: (i % 3) + 1, request_id: randomUUID() });
    }
    for (let i = 0; i < 4; i++)
      await db.query(
        "INSERT INTO logs_common(user_id,log_type,occurred_at) VALUES($1,'weight',NOW())",
        [id]
      );
    await db.query(
      "INSERT INTO coin_event_outbox(user_id,reason,ref_id,local_date) VALUES($1,'GIFT_OPEN','fixture',(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)",
      [id]
    );
    await Promise.all(Array.from({ length: 5 }, () => coins.processEvents(db, 100, id)));
    expect((await coins.today(db, id)).balance).toBe(42);
  });
  test('five simultaneous redemptions with one id spend once, and failure refunds once', async () => {
    const id = await user(),
      child = await user();
    await connect(id, child);
    await seedCoins(id);
    await db.query(
      "UPDATE greeting_templates SET active=TRUE,approved_by='test-fixture',approved_at=NOW() WHERE code='MISS_YOU'"
    );
    const input = {
      request_id: randomUUID(),
      payload: { recipientId: child, templateCode: 'MISS_YOU' },
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => coins.redeem(db, id, 'GREETING_CARD', input))
    );
    expect(new Set(results.map((x) => x.redemption.id)).size).toBe(1);
    expect((await coins.today(db, id)).balance).toBe(450);
    await Promise.all(Array.from({ length: 3 }, () => coins.refund(db, results[0].redemption.id)));
    expect((await coins.today(db, id)).balance).toBe(500);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM coin_ledger WHERE user_id=$1 AND reason='REFUND'",
          [id]
        )
      ).rows[0].n
    ).toBe(2);
  });
  test('insufficient funds and disabled draw cannot debit any coins', async () => {
    const id = await user();
    await expect(
      coins.redeem(db, id, 'DRAW_TICKET', { request_id: randomUUID(), payload: {} })
    ).rejects.toMatchObject({ code: 'COIN_DRAW_CLOSED' });
    expect((await coins.today(db, id)).balance).toBe(0);
  });
  test('expiry only subtracts unspent coins once', async () => {
    const id = await user();
    await seedCoins(id, 80);
    await db.query("UPDATE coin_lots SET expires_at=NOW()-INTERVAL '1 second' WHERE user_id=$1", [
      id,
    ]);
    await Promise.all([coins.daily(db), coins.daily(db)]);
    expect((await coins.today(db, id)).balance).toBe(0);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM coin_ledger WHERE user_id=$1 AND reason='EXPIRE'",
          [id]
        )
      ).rows[0].n
    ).toBe(1);
  });
  test('signed photo links expire/scope correctly and current membership is checked', async () => {
    const id = await user(),
      child = await user();
    await connect(id, child);
    const media = randomUUID();
    await db.query(
      'INSERT INTO med_media(id,patient_user_id,mime_type,payload,byte_length) VALUES($1,$2,$3,$4,12)',
      [
        media,
        id,
        'image/png',
        med.protect(id, 'med_media.payload', Buffer.from('photo-fixture').toString('base64')),
      ]
    );
    const url = scan.mediaUrl(media, id, child);
    const token = new URL('https://local' + url).searchParams.get('token');
    expect((await scan.readMedia(db, media, token)).buffer.toString()).toBe('photo-fixture');
    await db.query(
      "UPDATE user_connections SET status='rejected' WHERE requester_id=$1 AND addressee_id=$2",
      [id, child]
    );
    await expect(scan.readMedia(db, media, token)).rejects.toMatchObject({ statusCode: 403 });
  });
  test('atomic setup replays once and rolls back every new item on schedule failure', async () => {
    const id = await user(),
      body = {
        request_id: randomUUID(),
        items: [{ display_name: 'Thuốc sáng', kind: 'MEDICINE', source: 'CHIP', confirmed: true }],
        meals: { breakfast: '06:30', lunch: '11:30', dinner: '18:00', bedtime: '21:30' },
        slots: [{ time_local: '07:00', item_indexes: [0] }],
      };
    const [a, b] = await Promise.all([med.setup(db, id, id, body), med.setup(db, id, id, body)]);
    expect(a.schedules[0].id).toBe(b.schedules[0].id);
    expect((await med.overview(db, id, id)).items).toHaveLength(1);
    await expect(
      med.setup(db, id, id, { ...body, request_id: randomUUID() })
    ).rejects.toMatchObject({ code: '23505' });
    expect((await med.overview(db, id, id)).items).toHaveLength(1);
    await expect(
      med.setup(db, id, id, { ...body, meals: { ...body.meals, lunch: '12:00' } })
    ).rejects.toMatchObject({ code: 'MED_REQUEST_CHANGED' });
  });
  test('disabled schedule cannot be reactivated past the four-time cap', async () => {
    const id = await user(),
      i = await item(id),
      old = (
        await med.saveSchedule(db, id, id, null, {
          time_local: '06:00',
          item_ids: [i.id],
          active: false,
        })
      ).schedule;
    for (const time of ['07:00', '11:00', '18:00', '20:00'])
      await med.saveSchedule(db, id, id, null, { time_local: time, item_ids: [i.id] });
    await expect(
      med.saveSchedule(db, id, id, old.id, { time_local: '06:00', item_ids: [i.id] })
    ).rejects.toMatchObject({ code: 'MED_SCHEDULE_LIMIT' });
  });
  test('all health answers earn the same check-in award', async () => {
    const balances = [];
    for (const status of ['fine', 'tired', 'very_tired']) {
      const id = await user();
      await db.query(
        "INSERT INTO health_checkins(user_id,session_date,initial_status,current_status,flow_state,last_response_at) VALUES($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,$2,$2,'done',NOW())",
        [id, status]
      );
      balances.push((await coins.today(db, id)).balance);
    }
    expect(balances).toEqual([10, 10, 10]);
  });
  test('two doses under thirty minutes apart share one call and one check-in invitation', async () => {
    const id = await user(),
      a = await dose(id, { minutes: -10, time: '07:00' }),
      b = await dose(id, { minutes: 10, time: '07:20' });
    await calls.queueDue(db);
    const attempts = (
      await db.query('SELECT * FROM med_call_attempts WHERE dose_event_id=ANY($1::uuid[])', [
        [a.id, b.id],
      ])
    ).rows;
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((x) => x.group_id)).size).toBe(1);
    const out = await calls.answer(db, id, b.id, { button: 1, request_id: randomUUID() });
    expect(out.needsCheckin).toBe(true);
    expect(out.checkinDoseId).toBe(a.id);
    expect(
      (
        await db.query(
          'SELECT count(*)::int n FROM med_dose_events WHERE patient_user_id=$1 AND checkin_pending',
          [id]
        )
      ).rows[0].n
    ).toBe(1);
    expect((await coins.today(db, id)).balance).toBe(10);
  });
  test('reminders switched off create no attempts and cancel an already ringing call', async () => {
    const id = await user(),
      e = await dose(id);
    await db.query(
      'UPDATE user_notification_preferences SET reminders_enabled=FALSE WHERE user_id=$1',
      [id]
    );
    await calls.queueDue(db);
    expect(
      (await db.query('SELECT 1 FROM med_call_attempts WHERE dose_event_id=$1', [e.id])).rowCount
    ).toBe(0);
    await db.query(
      'UPDATE user_notification_preferences SET reminders_enabled=TRUE WHERE user_id=$1',
      [id]
    );
    await calls.queueDue(db);
    await db.query(
      'UPDATE user_notification_preferences SET reminders_enabled=FALSE WHERE user_id=$1',
      [id]
    );
    await maintenance.endPausedCalls(db);
    expect(
      (await db.query('SELECT state FROM med_dose_events WHERE id=$1', [e.id])).rows[0].state
    ).toBe('CANCELLED');
  });
  test('missing device reports at most once per patient day to each connected relative', async () => {
    const id = await user(),
      child = await user();
    await connect(id, child);
    await db.query(
      'UPDATE users SET push_token=NULL,fcm_token=NULL,voip_push_token=NULL WHERE id=$1',
      [id]
    );
    await dose(id, { time: '07:00' });
    await dose(id, { time: '11:00' });
    await calls.queueDue(db);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM v21_message_outbox WHERE subject_id=$1 AND kind='med_result'",
          [id]
        )
      ).rows[0].n
    ).toBe(1);
  });
  test('declining enforces seven days and pending forty-eight hours never auto-activates', async () => {
    const id = await user(),
      child = await user();
    await connect(id, child);
    const i = await item(id),
      s = (await med.saveSchedule(db, child, id, null, { time_local: '07:00', item_ids: [i.id] }))
        .schedule;
    await db.query(
      "UPDATE med_schedules SET created_at=NOW()-INTERVAL '49 hours',updated_at=NOW()-INTERVAL '49 hours' WHERE id=$1",
      [s.id]
    );
    await maintenance.consents(db);
    await maintenance.consents(db);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM v21_message_outbox WHERE kind='med_consent_pending' AND subject_id=$1",
          [id]
        )
      ).rows[0].n
    ).toBe(1);
    expect((await med.overview(db, id, id)).schedules[0].consent_state).toBe('PENDING');
    await med.consent(db, id, s.id, false);
    await expect(
      med.saveSchedule(db, child, id, null, { time_local: '08:00', item_ids: [i.id] })
    ).rejects.toMatchObject({ code: 'MED_CONSENT_COOLDOWN' });
  });
  test('five unique check-in days in one week award the weekly bonus once', async () => {
    const id = await user();
    for (let n = 0; n < 5; n++)
      await db.query(
        "INSERT INTO coin_event_outbox(user_id,reason,ref_id,local_date) VALUES($1,'CHECKIN',$2,date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+$3::int)",
        [id, 'week-' + n, n]
      );
    await Promise.all([coins.processEvents(db, 100, id), coins.processEvents(db, 100, id)]);
    expect((await coins.today(db, id)).balance).toBe(70);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM coin_ledger WHERE user_id=$1 AND reason='WEEKLY'",
          [id]
        )
      ).rows[0].n
    ).toBe(1);
  });
  test('revoking a recipient before card delivery refunds coins and preserves history', async () => {
    const id = await user(),
      child = await user();
    await connect(id, child);
    await seedCoins(id, 80);
    await db.query(
      "UPDATE greeting_templates SET active=TRUE,approved_by='test',approved_at=NOW() WHERE code='MISS_YOU'"
    );
    await coins.redeem(db, id, 'GREETING_CARD', {
      request_id: randomUUID(),
      payload: { recipientId: child, templateCode: 'MISS_YOU' },
    });
    await db.query(
      "UPDATE user_connections SET status='rejected' WHERE requester_id=$1 AND addressee_id=$2",
      [id, child]
    );
    await messages.processMessages(db);
    expect((await coins.today(db, id)).balance).toBe(80);
    expect(
      (await coins.history(db, id)).items.find((x) => x.reason === 'REDEEM').reward_status
    ).toBe('REFUNDED');
  });

  test('coin enqueue failure never rolls back accepted check-in or medication response', async () => {
    const id = await user();
    await db.query(
      `CREATE OR REPLACE FUNCTION v21_test_coin_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id=${id} THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$`
    );
    await db.query(
      'CREATE TRIGGER v21_fixture_fault BEFORE INSERT ON coin_event_outbox FOR EACH ROW EXECUTE FUNCTION v21_test_coin_fault()'
    );
    try {
      await db.query(
        "INSERT INTO health_checkins(user_id,session_date,initial_status,current_status,flow_state,last_response_at) VALUES($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'fine','fine','done',NOW())",
        [id]
      );
      const e = await dose(id);
      expect(
        (await calls.answer(db, id, e.id, { button: 2, request_id: randomUUID() })).event.state
      ).toBe('SKIPPED');
      expect(
        (await db.query('SELECT 1 FROM health_checkins WHERE user_id=$1', [id])).rowCount
      ).toBe(1);
      const session = (await db.query('SELECT * FROM health_checkins WHERE user_id=$1', [id]))
        .rows[0];
      const gifts = require('../../src/services/checkin-gifts/gift.service');
      const gift = await gifts.assign(db, id, session);
      expect(gift).toBeTruthy();
      expect((await gifts.open(db, id, gift.id, 1)).openedAt).toBeTruthy();
    } finally {
      await db.query('DROP TRIGGER v21_fixture_fault ON coin_event_outbox');
    }
  });
  test('registered enabled draw creates at most three tickets and includes them in CSV', async () => {
    const id = await user();
    await seedCoins(id, 1500);
    await db.query('UPDATE gift_config SET lucky_draw_enabled=TRUE WHERE id=1');
    const period = (
      await db.query(
        "INSERT INTO gift_draw_periods(code,prize_name,starts_at,closes_at,draw_at,rules,registration_reference,active) VALUES($1,'Fixture prize',NOW()-INTERVAL '1 day',NOW()+INTERVAL '1 day',NOW()+INTERVAL '2 days',$2,'fixture-registration',TRUE) RETURNING id",
        [randomUUID(), JSON.stringify({ vi: 'Fixture rules', en: 'Fixture rules' })]
      )
    ).rows[0];
    try {
      for (let i = 0; i < 3; i++)
        await coins.redeem(db, id, 'DRAW_TICKET', { request_id: randomUUID(), payload: {} });
      await expect(
        coins.redeem(db, id, 'DRAW_TICKET', { request_id: randomUUID(), payload: {} })
      ).rejects.toMatchObject({ code: 'COIN_REWARD_LIMIT' });
      const tickets = (
        await db.query("SELECT * FROM draw_tickets WHERE user_id=$1 AND source='coin'", [id])
      ).rows;
      expect(tickets).toHaveLength(3);
      await db.query(
        "UPDATE gift_draw_periods SET locked_at=NOW(),closes_at=NOW()-INTERVAL '1 second' WHERE id=$1",
        [period.id]
      );
      const csv =
        await require('../../src/services/checkin-gifts/gift-admin.service').exportTickets(
          db,
          period.id
        );
      for (const t of tickets) expect(csv).toContain(t.ticket_no);
      expect((await coins.today(db, id)).balance).toBe(600);
    } finally {
      await db.query('UPDATE gift_config SET lucky_draw_enabled=FALSE WHERE id=1');
      await db.query('UPDATE gift_draw_periods SET active=FALSE WHERE id=$1', [period.id]);
    }
  });
  test('medication check-in reuses original check-in service and stays idempotent', async () => {
    const id = await user(),
      e = await dose(id);
    await calls.answer(db, id, e.id, { button: 1, request_id: randomUUID() });
    const a = await calls.checkin(db, id, e.id, 'fine'),
      b = await calls.checkin(db, id, e.id, 'fine');
    expect(a.checkinId).toBe(b.checkinId);
    const session = (
      await db.query('SELECT occurrence_source FROM health_checkins WHERE id=$1', [a.checkinId])
    ).rows[0];
    expect(session.occurrence_source).toBe('med_call');
    expect(
      (await db.query('SELECT 1 FROM gift_events WHERE user_id=$1 AND opened_at IS NULL', [id]))
        .rowCount
    ).toBe(1);
    expect((await coins.today(db, id)).balance).toBe(15);
  });
  test('check-in call postpones medication until ten minutes after it finishes', async () => {
    const id = await user(),
      e = await dose(id),
      episode = (
        await db.query(
          "INSERT INTO checkin_call_episodes(user_id,local_date,scheduled_at,grace_until,config) VALUES($1,CURRENT_DATE,NOW(),NOW(),'{}') RETURNING id",
          [id]
        )
      ).rows[0];
    const attempt = (
      await db.query(
        "INSERT INTO checkin_call_attempts(episode_id,target_user_id,target_role,room_name,ring_deadline) VALUES($1,$2,'USER',$3,NOW()+INTERVAL '1 minute') RETURNING id",
        [episode.id, id, randomUUID()]
      )
    ).rows[0];
    await calls.queueDue(db);
    expect(
      (await db.query('SELECT 1 FROM med_call_attempts WHERE dose_event_id=$1', [e.id])).rowCount
    ).toBe(0);
    await db.query("UPDATE checkin_call_attempts SET state='ENDED',ended_at=NOW() WHERE id=$1", [
      attempt.id,
    ]);
    const next = await calls.busyUntil(db, id);
    expect(next.getTime() - Date.now()).toBeGreaterThan(599000);
  });

  test('native failure falls back to push within the same attempt and fixed TTS works offline', async () => {
    const id = await user(),
      e = await dose(id);
    await db.query("UPDATE med_dose_events SET timezone='UTC' WHERE id=$1", [e.id]);
    await db.query("UPDATE users SET voip_push_token='fixture-voip' WHERE id=$1", [id]);
    await calls.registerDevice(db, id, 'ios', 'fixture-voip', true);
    const previous = process.env.MED_CALL_ENABLED;
    process.env.MED_CALL_ENABLED = 'true';
    await db.query('UPDATE v21_config SET native_call_enabled=TRUE WHERE id=1');
    const native =
      require('../../src/services/notification/apns.voip.service').sendVoipNotification;
    native.mockResolvedValueOnce({ ok: false });
    try {
      await calls.queueDue(db);
      await calls.dispatchAttempts(db);
      const attempts = (
        await db.query('SELECT * FROM med_call_attempts WHERE dose_event_id=$1', [e.id])
      ).rows;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].channel).toBe('push');
      const cache = require('../../src/services/checkin-call/conclusion-audio.service');
      const spy = jest
        .spyOn(cache, 'getConclusionAudio')
        .mockRejectedValue(new Error('fixture unavailable'));
      try {
        const audio = await require('../../src/services/v21/audio.service').getAudio(
          db,
          id,
          e.id,
          'prompt',
          'en-US'
        );
        expect(audio.mime_type).toBe('audio/wav');
        expect(audio.audio_data.subarray(0, 4).toString()).toBe('RIFF');
      } finally {
        spy.mockRestore();
      }
    } finally {
      if (previous === undefined) delete process.env.MED_CALL_ENABLED;
      else process.env.MED_CALL_ENABLED = previous;
    }
  });
  test('deleting an account cascades its personal coin balance and medication data', async () => {
    const id = await user();
    await seedCoins(id, 75);
    await item(id);
    await db.query('DELETE FROM users WHERE id=$1', [id]);
    expect((await db.query('SELECT 1 FROM coin_balances WHERE user_id=$1', [id])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM coin_ledger WHERE user_id=$1', [id])).rowCount).toBe(0);
    expect(
      (await db.query('SELECT 1 FROM med_items WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(0);
  });

  test('remote resubmission after cooldown produces a fresh consent invitation', async () => {
    const id = await user(),
      child = await user();
    await connect(id, child);
    const i = await item(id),
      s = (await med.saveSchedule(db, child, id, null, { time_local: '07:00', item_ids: [i.id] }))
        .schedule;
    await med.consent(db, id, s.id, false);
    await db.query("UPDATE med_schedules SET declined_at=NOW()-INTERVAL '8 days' WHERE id=$1", [
      s.id,
    ]);
    const updated = (
      await med.saveSchedule(db, child, id, s.id, { time_local: '07:00', item_ids: [i.id] })
    ).schedule;
    expect(updated.consent_state).toBe('PENDING');
    expect(
      (await db.query('SELECT state FROM med_consent_calls WHERE schedule_id=$1', [s.id])).rows[0]
        .state
    ).toBe('QUEUED');
    expect(
      (
        await db.query(
          "SELECT 1 FROM v21_message_outbox WHERE subject_id=$1 AND kind='med_consent'",
          [id]
        )
      ).rowCount
    ).toBe(2);
  });
  test('weekly report is scoped to the patient and history accepts an empty first-page cursor', async () => {
    const id = await user(),
      child = await user();
    await connect(id, child);
    const e = await dose(id);
    await calls.answer(db, id, e.id, { button: 1, request_id: randomUUID() });
    await coins.today(db, id);
    const out = await request(app)
      .get('/api/mobile/medication/weekly-report?patientId=' + id)
      .set(auth(child))
      .expect(200);
    expect(out.body.report).toMatchObject({ taken: 1, total: 1, coins: 5 });
    await request(app).get('/api/mobile/coins/history?before=').set(auth(id)).expect(200);
  });
  test('two remote reminder hours have one invitation, one call, and an explicit atomic consent review', async () => {
    const id = await user(),
      child = await user(),
      stranger = await user();
    await connect(id, child);
    const result = await med.setup(db, child, id, {
      request_id: randomUUID(),
      items: [
        { display_name: 'Thuốc huyết áp', kind: 'MEDICINE', source: 'CHIP', confirmed: true },
      ],
      meals: { breakfast: '06:30', lunch: '11:30', dinner: '18:00', bedtime: '21:30' },
      slots: [
        { time_local: '07:00', item_indexes: [0] },
        { time_local: '19:00', item_indexes: [0] },
      ],
    });
    expect(result.schedules.every((s) => s.consent_state === 'PENDING')).toBe(true);
    expect(
      (
        await db.query(
          "SELECT 1 FROM v21_message_outbox WHERE subject_id=$1 AND kind='med_consent'",
          [id]
        )
      ).rowCount
    ).toBe(1);
    const clock = jest
      .spyOn(require('../../src/services/v21/medication.policy'), 'nextWindow')
      .mockReturnValue(new Date());
    try {
      await maintenance.consents(db);
    } finally {
      clock.mockRestore();
    }
    expect(
      (
        await db.query(
          "SELECT 1 FROM med_consent_calls WHERE patient_user_id=$1 AND state='DELIVERED'",
          [id]
        )
      ).rowCount
    ).toBe(1);
    await calls.prepare(db);
    expect(
      (await db.query('SELECT 1 FROM med_dose_events WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(0);
    const body = { schedule_ids: result.schedules.map((s) => s.id), accept: true };
    await request(app)
      .post('/api/mobile/medication/consents')
      .set(auth(stranger))
      .send(body)
      .expect(404);
    await request(app).post('/api/mobile/medication/consents').set(auth(id)).send(body).expect(200);
    expect(
      (await med.overview(db, id, id)).schedules.every((s) => s.consent_state === 'ACTIVE')
    ).toBe(true);
    await calls.prepare(db);
    expect(
      (await db.query('SELECT 1 FROM med_dose_events WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(2);
  });
  test('native cancellation status is read-only, scoped, expires and stops after schedule deletion', async () => {
    const id = await user(),
      e = await dose(id);
    await calls.queueDue(db);
    await db.query("UPDATE med_call_attempts SET state='DELIVERED' WHERE dose_event_id=$1", [e.id]);
    const a = (await db.query('SELECT * FROM med_call_attempts WHERE dose_event_id=$1', [e.id]))
        .rows[0],
      capability = calls.statusToken(a.id, id);
    await request(app)
      .post(`/api/mobile/med-native/${a.id}/status`)
      .send({ capability })
      .expect(200, { ok: true, active: true });
    await request(app)
      .post(`/api/mobile/med-native/${a.id}/decline`)
      .send({ capability })
      .expect(401);
    await request(app)
      .post(`/api/mobile/med-native/${a.id}/status`)
      .send({ capability: capability.slice(0, -1) + 'x' })
      .expect(401);
    await med.remove(db, id, id, e.schedule_id);
    await request(app)
      .post(`/api/mobile/med-native/${a.id}/status`)
      .send({ capability })
      .expect(200, { ok: true, active: false });
  });
  test('merged doses retry as one call, never two parallel calls', async () => {
    const id = await user(),
      a = await dose(id, { minutes: -10, time: '07:00' }),
      b = await dose(id, { minutes: 10, time: '07:20' });
    await calls.queueDue(db);
    await db.query(
      "UPDATE med_call_attempts SET deadline=NOW()-INTERVAL '1 second' WHERE dose_event_id=ANY($1::uuid[])",
      [[a.id, b.id]]
    );
    await calls.closeTimeouts(db);
    await db.query('UPDATE med_dose_events SET next_attempt_at=NOW() WHERE id=ANY($1::uuid[])', [
      [a.id, b.id],
    ]);
    await calls.queueDue(db);
    const attempts = (
      await db.query(
        'SELECT * FROM med_call_attempts WHERE dose_event_id=ANY($1::uuid[]) AND attempt_no=2',
        [[a.id, b.id]]
      )
    ).rows;
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((x) => x.group_id)).size).toBe(1);
  });
  test('a second device recovers the first dose check-in from either merged dose', async () => {
    const id = await user(),
      a = await dose(id, { minutes: -10, time: '07:00' }),
      b = await dose(id, { minutes: 10, time: '07:20' });
    await calls.queueDue(db);
    await calls.answer(db, id, b.id, { button: 1, request_id: randomUUID() });
    const replay = await calls.answer(db, id, b.id, { button: 2, request_id: randomUUID() });
    expect(replay.event.state).toBe('TAKEN');
    expect(replay.needsCheckin).toBe(true);
    expect(replay.checkinDoseId).toBe(a.id);
    const detail = await calls.detail(db, id, b.id);
    expect(detail.checkinDoseId).toBe(a.id);
  });
  test('future untouched dose follows a changed patient timezone without duplication', async () => {
    const id = await user(),
      i = await item(id),
      offset = 12 - new Date().getUTCHours();
    const tz = (n) => 'Etc/GMT' + (n >= 0 ? '-' : '+') + Math.abs(n),
      oldTz = tz(offset),
      newTz = tz(offset + 1);
    await db.query('INSERT INTO user_baselines(user_id,timezone) VALUES($1,$2)', [id, oldTz]);
    const schedule = (
      await med.saveSchedule(db, id, id, null, { time_local: '15:00', item_ids: [i.id] })
    ).schedule;
    await calls.prepare(db);
    const before = (
      await db.query('SELECT * FROM med_dose_events WHERE schedule_id=$1', [schedule.id])
    ).rows[0];
    await db.query('UPDATE user_baselines SET timezone=$2 WHERE user_id=$1', [id, newTz]);
    await calls.prepare(db);
    const rows = (
      await db.query('SELECT * FROM med_dose_events WHERE schedule_id=$1', [schedule.id])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].timezone).toBe(newTz);
    expect(new Date(before.scheduled_at) - new Date(rows[0].scheduled_at)).toBe(3600000);
  });
  function delayedTimeoutPool() {
    return {
      query: db.query.bind(db),
      connect: async () => {
        const client = await db.connect();
        return {
          release: () => client.release(),
          query: async (...args) => {
            const result = await client.query(...args);
            if (String(args[0]).includes("end_reason='no_answer'"))
              await new Promise((r) => setTimeout(r, 50));
            return result;
          },
        };
      },
    };
  }
  test('answer racing timeout never deadlocks or creates a second retry after a valid answer', async () => {
    const id = await user(),
      e = await dose(id);
    await calls.queueDue(db);
    await db.query(
      "UPDATE med_call_attempts SET deadline=NOW()-INTERVAL '1 second' WHERE dose_event_id=$1",
      [e.id]
    );
    const results = await Promise.allSettled([
      calls.closeTimeouts(delayedTimeoutPool()),
      calls.answer(db, id, e.id, { button: 1, request_id: randomUUID() }),
    ]);
    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)).toEqual([]);
    expect((await calls.detail(db, id, e.id)).event.state).toBe('TAKEN');
  });
  test('deleting a schedule racing timeout never deadlocks and leaves no live attempt', async () => {
    const id = await user(),
      e = await dose(id);
    await calls.queueDue(db);
    await db.query(
      "UPDATE med_call_attempts SET deadline=NOW()-INTERVAL '1 second' WHERE dose_event_id=$1",
      [e.id]
    );
    const results = await Promise.allSettled([
      calls.closeTimeouts(delayedTimeoutPool()),
      med.remove(db, id, id, e.schedule_id),
    ]);
    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)).toEqual([]);
    expect((await calls.detail(db, id, e.id)).event.state).toBe('CANCELLED');
  });
  test('voice transcription honors a remote patient AI refusal before contacting the provider', async () => {
    const parent = await user(),
      child = await user();
    await connect(parent, child);
    const consent = require('../../src/services/ai/ai-consent.service');
    await consent.grantAiConsent(db, child);
    await consent.revokeAiConsent(db, parent);
    const voice = jest
      .spyOn(require('../../src/services/voice/voice.service'), 'transcribeAudio')
      .mockResolvedValue('Thuốc huyết áp');
    try {
      const audio = fs.readFileSync(
        path.join(__dirname, '../../assets/medication-audio/vi-taken.wav')
      );
      const res = await request(app)
        .post('/api/mobile/med-items/transcribe?patientId=' + parent)
        .set(auth(child))
        .attach('audio', audio, { filename: 'name.wav', contentType: 'audio/wav' });
      expect(res.status).toBe(403);
      expect(voice).not.toHaveBeenCalled();
    } finally {
      voice.mockRestore();
    }
  });
  test.each(['remove', 'meals', 'preferences', 'item'])(
    'revoking Care Circle before the %s write transaction prevents the write',
    async (kind) => {
      const id = await user(),
        child = await user();
      await connect(id, child);
      const i = await item(id),
        schedule = (
          await med.saveSchedule(db, id, id, null, { time_local: '07:00', item_ids: [i.id] })
        ).schedule;
      let revoked = false;
      const pool = {
        connect: db.connect.bind(db),
        query: async (...args) => {
          const result = await db.query(...args);
          if (!revoked && String(args[0]).includes('SELECT 1 FROM user_connections')) {
            revoked = true;
            await db.query(
              "UPDATE user_connections SET status='rejected' WHERE requester_id=$1 AND addressee_id=$2",
              [id, child]
            );
          }
          return result;
        },
      };
      const work =
        kind === 'remove'
          ? () => med.remove(pool, child, id, schedule.id)
          : kind === 'meals'
            ? () =>
                med.saveMeals(pool, child, id, {
                  breakfast: '08:00',
                  lunch: '12:00',
                  dinner: '19:00',
                  bedtime: '22:00',
                })
            : kind === 'preferences'
              ? () => med.preferences(pool, child, id, { problems_only: true })
              : () =>
                  med.createItem(pool, child, id, {
                    display_name: 'Thuốc khác',
                    kind: 'MEDICINE',
                    source: 'CHIP',
                    confirmed: true,
                  });
      await expect(work()).rejects.toMatchObject({ code: 'MED_CARE_CIRCLE_REQUIRED' });
      expect(
        (await db.query('SELECT active FROM med_schedules WHERE id=$1', [schedule.id])).rows[0]
          .active
      ).toBe(true);
    }
  );
  test('connected patients can answer concurrently without locking each other via family foreign keys', async () => {
    const a = await user(),
      b = await user();
    await connect(a, b);
    const ea = await dose(a),
      eb = await dose(b);
    const result = await Promise.allSettled([
      calls.answer(db, a, ea.id, { button: 2, request_id: randomUUID() }),
      calls.answer(db, b, eb.id, { button: 3, request_id: randomUUID() }),
    ]);
    expect(result.filter((x) => x.status === 'rejected')).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT 1 FROM v21_message_outbox WHERE kind='med_result' AND subject_id=ANY($1::int[])",
          [[a, b]]
        )
      ).rowCount
    ).toBe(2);
  });
  test('daily task progress and ledger dates use Vietnam date under any Node process timezone', async () => {
    const id = await user();
    await db.query(
      "INSERT INTO health_checkins(user_id,session_date,initial_status,current_status,flow_state,last_response_at) VALUES($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'fine','fine','done',NOW())",
      [id]
    );
    const today = await coins.today(db, id);
    expect(today.tasks.find((x) => x.task_code === 'CHECKIN').done).toBe(1);
    expect(
      (
        await db.query(
          "SELECT local_date::text AS calendar_date FROM coin_ledger WHERE user_id=$1 AND reason='CHECKIN'",
          [id]
        )
      ).rows[0].calendar_date
    ).toBe(c.localDate());
  });
  test('SRS EA9/EA12: alerts honor permissions and problems-only; repeated out-of-meds counts stay private', async () => {
    const parent = await user(),
      child = await user(),
      muted = await user();
    await connect(parent, child);
    await connect(parent, muted);
    await db.query(
      'UPDATE user_connections SET permissions=permissions||\'{"can_receive_alerts":false}\'::jsonb WHERE requester_id=$1 AND addressee_id=$2',
      [parent, muted]
    );
    await med.preferences(db, child, parent, { problems_only: true });
    const morning = await dose(parent);
    await calls.answer(db, parent, morning.id, { button: 1, request_id: randomUUID() });
    expect(
      (
        await db.query(
          "SELECT 1 FROM v21_message_outbox WHERE subject_id=$1 AND kind='med_result'",
          [parent]
        )
      ).rowCount
    ).toBe(0);
    for (const time of ['11:00', '19:00']) {
      const e = await dose(parent, { time });
      await calls.answer(db, parent, e.id, { button: 3, request_id: randomUUID() });
    }
    const results = (
      await db.query(
        "SELECT * FROM v21_message_outbox WHERE subject_id=$1 AND kind='med_result' ORDER BY id",
        [parent]
      )
    ).rows;
    expect(results).toHaveLength(2);
    expect(results.map((x) => x.recipient_id)).toEqual([child, child]);
    expect(results.map((x) => x.payload.repeatCount)).toEqual([1, 2]);
    for (const row of results) {
      for (const en of [false, true])
        expect(JSON.stringify(messages.copy(row.kind, row.payload, en))).not.toContain(
          'Thuốc huyết áp'
        );
    }
    const alone = await user(),
      e = await dose(alone);
    await calls.answer(db, alone, e.id, { button: 3, request_id: randomUUID() });
    expect(
      (
        await db.query(
          "SELECT 1 FROM v21_message_outbox WHERE subject_id=$1 AND kind='med_result'",
          [alone]
        )
      ).rowCount
    ).toBe(0);
  });
  test('SRS EA10: an existing app check-in prevents another question or a second daily check-in award', async () => {
    const id = await user();
    await db.query(
      "INSERT INTO health_checkins(user_id,session_date,initial_status,current_status,flow_state,last_response_at) VALUES($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'fine','fine','done',NOW())",
      [id]
    );
    const e = await dose(id);
    const answer = await calls.answer(db, id, e.id, { button: 1, request_id: randomUUID() });
    expect(answer.needsCheckin).toBe(false);
    expect((await calls.detail(db, id, e.id)).needsCheckin).toBe(false);
    await calls.checkin(db, id, e.id, 'fine');
    expect((await db.query('SELECT 1 FROM health_checkins WHERE user_id=$1', [id])).rowCount).toBe(
      1
    );
    expect((await coins.today(db, id)).balance).toBe(15);
  });
  test('SRS EA8: editing an active schedule preserves answered snapshots and replaces only untouched future doses', async () => {
    const id = await user(),
      old = await dose(id);
    await calls.answer(db, id, old.id, { button: 1, request_id: randomUUID() });
    const future = randomUUID();
    await db.query(
      "INSERT INTO med_dose_events(id,schedule_id,patient_user_id,local_date,scheduled_at,next_attempt_at,timezone,has_medicine) VALUES($1,$2,$3,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+1,NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day','Asia/Ho_Chi_Minh',TRUE)",
      [future, old.schedule_id, id]
    );
    const replacement = (
      await med.createItem(db, id, id, {
        display_name: 'Thuốc khác',
        kind: 'MEDICINE',
        source: 'CHIP',
        confirmed: true,
      })
    ).item;
    await med.saveSchedule(db, id, id, old.schedule_id, {
      time_local: '08:00',
      item_ids: [replacement.id],
    });
    expect(
      (await db.query('SELECT state FROM med_dose_events WHERE id=$1', [old.id])).rows[0].state
    ).toBe('TAKEN');
    expect((await db.query('SELECT 1 FROM med_dose_events WHERE id=$1', [future])).rowCount).toBe(
      0
    );
    const snapshot = (
      await db.query('SELECT * FROM med_dose_items WHERE dose_event_id=$1', [old.id])
    ).rows[0];
    expect(med.reveal(id, 'med_dose_items.display_name', snapshot.display_name)).toBe(
      'Thuốc huyết áp'
    );
    expect(
      (
        await db.query(
          "SELECT 1 FROM med_schedule_audit WHERE schedule_id=$1 AND action='updated'",
          [old.schedule_id]
        )
      ).rowCount
    ).toBe(1);
  });
  test('SRS EB10: expiry reminder is emitted once within seven days, excludes spent lots and never expires early', async () => {
    const id = await user();
    await seedCoins(id, 80);
    await db.query("UPDATE coin_lots SET expires_at=NOW()+INTERVAL '6 days' WHERE user_id=$1", [
      id,
    ]);
    await coins.daily(db);
    await coins.daily(db);
    const reminder = (
      await db.query(
        "SELECT * FROM v21_message_outbox WHERE subject_id=$1 AND kind='coin_expiring'",
        [id]
      )
    ).rows;
    expect(reminder).toHaveLength(1);
    expect(reminder[0].payload.coins).toBe(80);
    expect((await coins.today(db, id)).balance).toBe(80);
    expect(
      (await db.query("SELECT 1 FROM coin_ledger WHERE user_id=$1 AND reason='EXPIRE'", [id]))
        .rowCount
    ).toBe(0);
  });
});
