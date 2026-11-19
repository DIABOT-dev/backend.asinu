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
  sendPushNotification: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../src/services/notification/notification-quiet-hours.policy', () => {
  const actual = jest.requireActual(
    '../../src/services/notification/notification-quiet-hours.policy'
  );
  return { ...actual, getQuietHoursHoldUntil: jest.fn(actual.getQuietHoursHoldUntil) };
});
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
const greetingCards = require('../../src/services/v21/greeting-cards.service');
const notificationDelivery = require('../../src/services/notification/notification-dispatch.service');
const quietHours = require('../../src/services/notification/notification-quiet-hours.policy');
const actualQuietHours = jest.requireActual(
  '../../src/services/notification/notification-quiet-hours.policy'
);
const pushProvider = require('../../src/services/notification/push.notification.service');
const source =
  fs.readFileSync(
    path.join(__dirname, '../../db/migrations/123_medication_and_coins.sql'),
    'utf8'
  ) +
  fs.readFileSync(
    path.join(__dirname, '../../db/migrations/126_medication_setup_drafts.sql'),
    'utf8'
  ) +
  fs.readFileSync(
    path.join(__dirname, '../../db/migrations/127_medication_multiple_drafts.sql'),
    'utf8'
  ) + fs.readFileSync(path.join(__dirname, '../../db/migrations/132_assistant_action_receipts.sql'), 'utf8');
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
    await db.query(
      fs.readFileSync(
        path.join(__dirname, '../../db/migrations/125_medication_purpose_tags.sql'),
        'utf8'
      )
    );
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
   VALUES($1,$2,$3,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,NOW()+($4*INTERVAL '1 minute'),NOW(), 'Asia/Ho_Chi_Minh',$5)
   ON CONFLICT(schedule_id,local_date) DO UPDATE SET scheduled_at=EXCLUDED.scheduled_at,next_attempt_at=EXCLUDED.next_attempt_at RETURNING *`,
        [randomUUID(), s.id, id, minutes, kind === 'MEDICINE']
      )
    ).rows[0];
    // A saved schedule already prepares today's snapshot; customize the fixture
    // once instead of adding duplicate dose items for its synthetic time.
    await db.query('DELETE FROM med_dose_items WHERE dose_event_id=$1', [e.id]);
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
  test('assistant medication: preview is read-only; confirmation creates real schedules and retries only once', async () => {
    const assistant = require('../../src/services/assistant/medication-assistant.service');
    const ai = require('../../src/services/ai/ai-consent.service');
    const id = await user(), other = await user();
    await ai.grantAiConsent(db, id); await ai.grantAiConsent(db, other);
    const context = await assistant.contextForPlan(db, id);
    const action = assistant.prepare([{ type: 'medication_create', name: 'Hapacol', times: ['07:00', '19:00'],
      evidence: 'nhắc uống Hapacol mỗi ngày 7 giờ sáng và 7 giờ tối' }], context, id);
    expect((await med.overview(db, id, id)).items).toHaveLength(0);
    await expect(assistant.execute(db, other, action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
    const [result, duplicate] = await Promise.all([
      assistant.execute(db, id, action.planToken), assistant.execute(db, id, action.planToken),
    ]);
    expect(result).toMatchObject({ status: 'applied', count: 2 });
    expect(!!result.replay || !!duplicate.replay).toBe(true);
    expect(await assistant.execute(db, id, action.planToken)).toMatchObject({ replay: true });
    const overview = await med.overview(db, id, id);
    expect(overview.items.map(item => item.display_name)).toEqual(['Hapacol']);
    expect(overview.schedules.map(row => row.time_local)).toEqual(['07:00', '19:00']);
    expect((await assistant.contextForPlan(db, other)).schedules).toHaveLength(0);
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60000);
    try { expect(await assistant.execute(db, id, action.planToken)).toMatchObject({ replay: true }); }
    finally { now.mockRestore(); }
  });
  test('assistant medication: moving a medicine preserves its group companions, and stale plans cannot overwrite edits', async () => {
    const assistant = require('../../src/services/assistant/medication-assistant.service');
    const id = await user();
    await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
    const a = await item(id), b = await item(id, 'SUPPLEMENT');
    const original = (await med.saveSchedule(db, id, id, null, { time_local: '07:00', item_ids: [a.id, b.id] })).schedule;
    const context = await assistant.contextForPlan(db, id);
    const action = assistant.prepare([{ type: 'medication_move', medicine_ref: `m${context.items.findIndex(row => row.id === a.id) + 1}`,
      schedule_ref: 's1', time_local: '08:00', evidence: 'đổi thuốc huyết áp từ 7 giờ sáng sang 8 giờ sáng' }], context, id);
    await assistant.execute(db, id, action.planToken);
    const current = await med.overview(db, id, id);
    expect(current.schedules.find(row => row.time_local === '07:00').item_ids).toEqual([b.id]);
    expect(current.schedules.find(row => row.time_local === '08:00').item_ids).toEqual([a.id]);
    const nextContext = await assistant.contextForPlan(db, id);
    const stale = assistant.prepare([{ type: 'medication_move', medicine_ref: `m${nextContext.items.findIndex(row => row.id === b.id) + 1}`,
      schedule_ref: `s${nextContext.schedules.findIndex(row => row.id === original.id) + 1}`, time_local: '09:00', evidence: 'đổi Vitamin D3 sang 9 giờ sáng' }], nextContext, id);
    await med.saveSchedule(db, id, id, original.id, { time_local: '07:30', item_ids: [b.id] });
    await expect(assistant.execute(db, id, stale.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_MEDICATION_CONFLICT' });
    expect((await med.overview(db, id, id)).schedules.map(row => row.time_local)).toEqual(['07:30', '08:00']);
  });
  test('assistant medication: confirmed catalog tags are encrypted, owner-bound and saved only with the reminder; existing tags survive reuse', async () => {
    const assistant = require('../../src/services/assistant/medication-assistant.service');
    const purpose = require('../../src/services/v21/medication-purpose.service');
    const id = await user(), other = await user();
    await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
    const productUrl = 'https://dhgpharma.com.vn/vi/san-pham/giam-dau-ha-sot/hapacol-650-0';
    const fetcher = jest.spyOn(global, 'fetch').mockImplementation(async url => new Response(
      url.endsWith('/sitemap.xml') ? `<urlset><url><loc>${productUrl}</loc></url></urlset>`
        : '<div class="field-field-display-title">Hapacol 650</div><div class="field-field-n-p-indication">Điều trị các triệu chứng đau. Hạ sốt.</div>'
    ));
    const lookup = jest.spyOn(purpose, 'lookup');
    try {
      const context = await assistant.contextForPlan(db, id);
      const input = { type: 'medication_create', name: 'Hapacol 650', times: ['07:00'], evidence: 'nhắc uống Hapacol 650 mỗi ngày lúc 7 giờ sáng' };
      const preview = await assistant.prepareWithPurpose(db, [input], context, id);
      expect(preview.changes[0].purpose).toMatchObject({ status: 'matched', tags: ['fever_reduction', 'pain_relief'], source: { url: productUrl } });
      expect((await med.overview(db, id, id)).items).toHaveLength(0);
      await expect(assistant.execute(db, other, preview.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
      // Mutable display metadata cannot alter what the signed confirmation saves.
      preview.changes[0].purpose.tags = ['diabetes'];
      await assistant.execute(db, id, preview.planToken);
      expect(await assistant.execute(db, id, preview.planToken)).toMatchObject({ replay: true });
      const stored = (await med.overview(db, id, id)).items[0];
      expect(stored.purpose_tags).toMatchObject({ codes: ['fever_reduction', 'pain_relief'], confirmedBy: id, source: { url: productUrl } });
      const raw = (await db.query('SELECT tags_json FROM med_items WHERE id=$1', [stored.id])).rows[0].tags_json;
      expect(raw).not.toContain('fever_reduction'); expect(raw).not.toContain('DHG');
      const updated = await assistant.contextForPlan(db, id);
      expect(JSON.stringify(assistant.modelContext(updated))).not.toContain(productUrl);
      const reuse = await assistant.prepareWithPurpose(db, [{ ...input, times: ['19:00'] }], updated, id);
      expect(reuse.changes[0].purpose.tags).toEqual(['fever_reduction', 'pain_relief']);
      expect(lookup).toHaveBeenCalledTimes(1);
      await assistant.execute(db, id, reuse.planToken);
      const after = await med.overview(db, id, id);
      expect(after.items).toHaveLength(1); expect(after.schedules).toHaveLength(2);
      expect(after.items[0].purpose_tags).toEqual(stored.purpose_tags);
    } finally { lookup.mockRestore(); fetcher.mockRestore(); }
  });
  test('assistant medication: expired/revoked previews never write and a failed batch rolls back all new medicines', async () => {
    const assistant = require('../../src/services/assistant/medication-assistant.service');
    const ai = require('../../src/services/ai/ai-consent.service');
    const id = await user(); await ai.grantAiConsent(db, id);
    const context = await assistant.contextForPlan(db, id);
    const create = { type: 'medication_create', name: 'Hapacol', times: ['07:00'], evidence: 'Hapacol mỗi ngày 7 giờ sáng' };
    const plan = assistant.prepare([create], context, id);
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60000);
    try { await expect(assistant.execute(db, id, plan.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' }); }
    finally { now.mockRestore(); }
    await ai.revokeAiConsent(db, id);
    await expect(assistant.execute(db, id, plan.planToken)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    await ai.grantAiConsent(db, id);
    const existing = await item(id);
    for (const time_local of ['07:00', '12:00', '19:00']) await med.saveSchedule(db, id, id, null, { time_local, item_ids: [existing.id] });
    const full = assistant.prepare([{ ...create, times: ['08:00', '09:00'] }], await assistant.contextForPlan(db, id), id);
    await expect(assistant.execute(db, id, full.planToken)).rejects.toMatchObject({ code: 'MED_SCHEDULE_LIMIT' });
    const overview = await med.overview(db, id, id);
    expect(overview.items).toHaveLength(1); expect(overview.schedules).toHaveLength(3);
  });
  test('assistant draft management: read-only list, scoped resume, revision conflicts, confirmed deletion and replay', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const drafts = require('../../src/services/v21/medication-drafts.service');
    const id = await user(), other = await user();
    await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
    const raw = (tool, parameters = {}) => ({ type: 'app_tool', tool, parameters, evidence: 'Xem và quản lý bản nháp lịch thuốc' });
    expect((await tools.prepare(db, id, raw('medication.drafts'))).answer).toContain('chưa có');
    expect((await db.query('SELECT id FROM med_setup_drafts WHERE actor_id=$1', [id])).rows).toHaveLength(0);
    const snapshot = { version: 1, step: 2, items: [{ clientId: randomUUID(), display_name: 'Vitamin D3', kind: 'SUPPLEMENT', source: 'VOICE', confirmed: true, anchors: [] }],
      meals: { breakfast: '07:00', lunch: '12:00', dinner: '18:00', bedtime: '21:00' }, slots: [], photoMediaId: null };
    const draftId = randomUUID(); await drafts.write(db, id, id, { id: draftId, revision: 0, snapshot });
    expect(await tools.prepare(db, id, raw('medication.draft_resume', { target: 'Vitamin D3' }))).toMatchObject({ screen: { screen: 'medication_draft', params: { id: draftId } } });
    expect((await tools.prepare(db, other, raw('medication.draft_resume', { target: 'Vitamin D3' }))).screen).toBeUndefined();
    const stale = await tools.prepare(db, id, raw('medication.draft_delete', { target: 'Vitamin D3' }));
    await drafts.write(db, id, id, { id: draftId, revision: 1, snapshot: { ...snapshot, step: 3 } });
    await expect(tools.execute(db, id, stale.action.planToken)).rejects.toMatchObject({ code: 'MED_DRAFT_CHANGED' });
    const preview = await tools.prepare(db, id, raw('medication.draft_delete', { target: 'Vitamin D3' }));
    expect((await drafts.read(db, id, id, { recoverLegacy: false })).drafts).toHaveLength(1);
    await expect(tools.execute(db, other, preview.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
    await tools.execute(db, id, preview.action.planToken);
    const secondId = randomUUID(); await drafts.write(db, id, id, { id: secondId, revision: 0, snapshot });
    expect(await tools.execute(db, id, preview.action.planToken)).toMatchObject({ replay: true });
    expect((await drafts.read(db, id, id, { recoverLegacy: false })).drafts.map(row => row.id)).toEqual([secondId]);
    expect((await db.query('SELECT id FROM med_items WHERE patient_user_id=$1', [id])).rows).toHaveLength(0);
  });
  test('assistant supplement creation saves SUPPLEMENT and does not classify it or enable medicine calls', async () => {
    const assistant = require('../../src/services/assistant/medication-assistant.service');
    const lookup = jest.spyOn(require('../../src/services/v21/medication-purpose.service'), 'lookup');
    try {
      const id = await user(); await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
      const action = { type: 'medication_create', kind: 'SUPPLEMENT', name: 'Vitamin D3', times: ['07:00'], evidence: 'Nhắc dùng vitamin D3 mỗi ngày lúc 7 giờ sáng' };
      const preview = await assistant.prepareWithPurpose(db, [action], await assistant.contextForPlan(db, id), id);
      expect((await med.overview(db, id, id)).items).toHaveLength(0);
      await assistant.execute(db, id, preview.planToken);
      const overview = await med.overview(db, id, id);
      expect(overview.items[0]).toMatchObject({ kind: 'SUPPLEMENT', purpose_tags: null });
      const events = (await db.query('SELECT has_medicine FROM med_dose_events WHERE patient_user_id=$1', [id])).rows;
      expect(events.length).toBeGreaterThan(0); expect(events.every(row => row.has_medicine === false)).toBe(true);
      expect(lookup).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });
  test('assistant purpose selection: only verified tags, explicit confirmation, stale checks and receipts across later edits', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const purpose = require('../../src/services/v21/medication-purpose.service');
    const id = await user(), other = await user(); await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
    const match = { status: 'matched', tags: ['pain_relief', 'fever_reduction'], productName: 'Hapacol 650', source: { name: 'DHG Pharma', url: 'https://dhgpharma.com.vn/vi/san-pham/giam-dau-ha-sot/hapacol-650-0' }, checkedAt: new Date().toISOString() };
    const token = jwt.sign({ purpose: 'med-purpose-tags', actor: id, patient: id, name: require('node:crypto').createHash('sha256').update('hapacol 650').digest('hex'), ...match }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const saved = (await med.createItem(db, id, id, { display_name: 'Hapacol 650', kind: 'MEDICINE', source: 'VOICE', confirmed: true,
      tag_confirmation: { token, codes: match.tags } })).item;
    const raw = (mode, tags = []) => ({ type: 'app_tool', tool: 'medication.purpose', parameters: { target: 'Hapacol 650', mode, tags }, evidence: 'Đổi tag công dụng của thuốc Hapacol 650' });
    const lookup = jest.spyOn(purpose, 'lookup').mockResolvedValue({ ...match, token });
    try {
      const remove = await tools.prepare(db, id, raw('remove', ['fever_reduction']));
      expect((await med.overview(db, id, id)).items[0].purpose_tags.codes).toHaveLength(2);
      await expect(tools.execute(db, other, remove.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
      await tools.execute(db, id, remove.action.planToken);
      expect((await med.overview(db, id, id)).items[0].purpose_tags.codes).toEqual(['pain_relief']);
      const add = await tools.prepare(db, id, raw('add', ['fever_reduction'])); await tools.execute(db, id, add.action.planToken);
      expect(await tools.execute(db, id, remove.action.planToken)).toMatchObject({ replay: true });
      expect((await med.overview(db, id, id)).items[0].purpose_tags.codes).toEqual(['pain_relief', 'fever_reduction']);
      expect((await tools.prepare(db, id, raw('add', ['diabetes']))).clarify).toContain('chưa xác nhận');
      const stale = await tools.prepare(db, id, raw('clear'));
      await db.query('UPDATE med_items SET display_name=$2,tags_json=NULL WHERE id=$1', [saved.id, med.protect(id, 'med_items.display_name', 'Tên thuốc mới')]);
      await expect(tools.execute(db, id, stale.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_TOOL_CONFLICT' });
    } finally { lookup.mockRestore(); }
  });
  test('assistant protected members: owner-only, no preview writes, full-plan checks, conflict rollback and idempotent confirmation', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const entitlement = require('../../src/services/payment/entitlement.service');
    const household = require('../../src/services/payment/household.service');
    const owner = await user(), a = await user(), b = await user();
    await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, owner);
    await connect(owner, a); await connect(owner, b);
    await db.query('UPDATE users SET full_name=$2,display_name=$2 WHERE id=$1', [a, 'Người A']);
    await db.query('UPDATE users SET full_name=$2,display_name=$2 WHERE id=$1', [b, 'Người B']);
    const h = await entitlement.ensureHousehold(db, owner);
    await db.query("UPDATE subscription_households SET plan_code='antam_2',status='active',current_period_end=NOW()+INTERVAL '30 days' WHERE id=$1", [h.id]);
    const raw = (tool, target) => ({ type: 'app_tool', tool, parameters: { target }, evidence: `${tool} ${target}` });
    const add = await tools.prepare(db, owner, raw('subscription.member_add', 'Người A'));
    expect((await household.listProtectedMembers(db, owner)).protectedMemberCount).toBe(1);
    await expect(tools.execute(db, a, add.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
    await tools.execute(db, owner, add.action.planToken);
    expect((await household.listProtectedMembers(db, owner)).members.map(row => row.userId)).toEqual(expect.arrayContaining([owner, a]));
    expect((await tools.prepare(db, owner, raw('subscription.member_add', 'Người B'))).clarify).toContain('đủ số người');
    await db.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [a]);
    expect((await tools.prepare(db, owner, raw('subscription.member_add', 'Người B'))).clarify).toContain('đủ số người');
    await db.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [a]);
    expect((await tools.prepare(db, a, raw('subscription.member_remove', 'Người A'))).clarify).toContain('chủ gói');
    const remove = await tools.prepare(db, owner, raw('subscription.member_remove', 'Người A')); await tools.execute(db, owner, remove.action.planToken);
    expect(await tools.execute(db, owner, add.action.planToken)).toMatchObject({ replay: true });
    expect((await household.listProtectedMembers(db, owner)).members.map(row => row.userId)).toEqual([owner]);
    const stale = await tools.prepare(db, owner, raw('subscription.member_add', 'Người B'));
    await household.addProtectedMember(db, owner, a);
    await expect(tools.execute(db, owner, stale.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_TOOL_CONFLICT' });
    expect((await household.listProtectedMembers(db, owner)).members.map(row => row.userId)).toEqual(expect.arrayContaining([owner, a]));
    expect((await db.query("SELECT status FROM user_connections WHERE requester_id=$1 AND addressee_id=$2", [owner, a])).rows[0].status).toBe('accepted');
  });
  test('assistant tools: data queries calculate only the authenticated owner readings and Vietnam date window', async () => {
    const tools = require('../../src/services/assistant/app-tools.service');
    const id = await user(), other = await user();
    for (const [owner, amount, days] of [[id, 200, 0], [id, 300, 1], [other, 9999, 0]]) {
      const log = randomUUID();
      await db.query("INSERT INTO logs_common(id,user_id,log_type,occurred_at,source) VALUES($1,$2,'water',now()-($3*interval '1 day'),'manual')", [log, owner, days]);
      await db.query('INSERT INTO water_logs(log_id,volume_ml) VALUES($1,$2)', [log, amount]);
    }
    const client = await db.connect();
    try {
      for (const timezone of ['UTC', 'Asia/Ho_Chi_Minh', 'America/New_York']) {
        await client.query("SELECT set_config('TimeZone',$1,FALSE)", [timezone]);
        expect(await tools.query(client, id, { topic: 'water', range: 'today' }, 'vi')).toContain('200 ml');
        expect(await tools.query(client, id, { topic: 'water', range: 'week' }, 'vi')).toContain('500 ml');
        expect(await tools.query(client, id, { topic: 'water', range: 'yesterday' }, 'vi')).toContain('300 ml');
        expect(await tools.query(client, other, { topic: 'water', range: 'today' }, 'vi')).toContain('9999 ml');
      }
    } finally {
      await client.query('RESET TimeZone');
      client.release();
    }
    for (const [systolic, diastolic] of [[140, 90], [120, 80]]) {
      const log = randomUUID();
      await db.query("INSERT INTO logs_common(id,user_id,log_type,occurred_at,source) VALUES($1,$2,'bp',now(),'manual')", [log, id]);
      await db.query('INSERT INTO blood_pressure_logs(log_id,systolic,diastolic,unit) VALUES($1,$2,$3,\'mmHg\')', [log, systolic, diastolic]);
    }
    expect(await tools.query(db, id, { topic: 'blood_pressure', range: 'today', statistic: 'average' }, 'vi')).toContain('130.0/85.0 mmHg');
    expect(await tools.query(db, id, { topic: 'blood_pressure', range: 'today', statistic: 'max' }, 'vi')).toContain('140/90 mmHg');
    expect(await tools.query(db, other, { topic: 'blood_pressure', range: 'today' }, 'vi')).toContain('chưa có');
  });
  test('assistant tools: reminder pause, resume, deletion and dose acknowledgements reuse real medication services', async () => {
    const assistant = require('../../src/services/assistant/medication-assistant.service');
    const id = await user(); await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
    const event = await dose(id);
    let context = await assistant.contextForPlan(db, id);
    const answer = assistant.prepare([{ type: 'medication_answer', dose_ref: `d${context.doses.findIndex(row => row.id === event.id) + 1}`,
      answer: 'taken', evidence: 'Tôi đã uống thuốc rồi' }], context, id);
    await assistant.execute(db, id, answer.planToken);
    expect((await db.query('SELECT state FROM med_dose_events WHERE id=$1', [event.id])).rows[0].state).toBe('TAKEN');
    expect(await assistant.execute(db, id, answer.planToken)).toMatchObject({ replay: true });
    for (const state of ['pause', 'resume', 'delete']) {
      context = await assistant.contextForPlan(db, id);
      const plan = assistant.prepare([{ type: 'medication_state', schedule_ref: 's1', state, evidence: 'thao tác lịch thuốc' }], context, id);
      await assistant.execute(db, id, plan.planToken);
      const next = await assistant.contextForPlan(db, id);
      if (state === 'delete') expect(next.schedules).toHaveLength(0);
      else expect(next.schedules[0].active).toBe(state === 'resume');
    }
    expect((await db.query('SELECT state FROM med_dose_events WHERE id=$1', [event.id])).rows[0].state).toBe('TAKEN');
  });
  test('assistant tools: signed profile confirmations are owner-bound, replay safely and reject concurrent edits', async () => {
    const profile = require('../../src/services/assistant/profile-assistant.service');
    const service = require('../../src/services/profile/profile.service');
    const ai = require('../../src/services/ai/ai-consent.service');
    const id = await user(), other = await user(); await ai.grantAiConsent(db, id); await ai.grantAiConsent(db, other);
    const initial = await profile.read(db, id);
    const action = profile.prepare({ type: 'profile', changes: { name: 'Trần An', chronicDiseases: ['Tiểu đường'] }, evidence: 'sửa hồ sơ' }, initial, id);
    await expect(profile.execute(db, other, action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
    const result = await profile.execute(db, id, action.planToken);
    expect(result.profile.name).toBe('Trần An'); expect(result.profile.chronicDiseases).toContain('Tiểu đường');
    const version = (await profile.read(db, id)).version;
    expect(await profile.execute(db, id, action.planToken)).toMatchObject({ replay: true });
    expect((await profile.read(db, id)).version).toBe(version);
    const context = await profile.read(db, id);
    const pending = profile.prepare({ type: 'profile', changes: { chronicDiseases: ['Tiểu đường', 'Cao huyết áp'] }, evidence: 'thêm bệnh nền' }, context, id);
    await service.updateProfile(db, id, { chronicDiseases: ['Tiểu đường', 'Gút'] });
    await expect(profile.execute(db, id, pending.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PROFILE_CONFLICT' });
    expect((await profile.read(db, id)).chronicDiseases).toEqual(['Tiểu đường', 'Gút']);
    const revoked = profile.prepare({ type: 'profile', changes: { name: 'An mới' }, evidence: 'sửa tên' }, await profile.read(db, id), id);
    await ai.revokeAiConsent(db, id);
    await expect(profile.execute(db, id, revoked.planToken)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    expect((await profile.read(db, id)).name).toBe('Trần An');
  });
  test('assistant app tools: bounded inbox changes are owner-only and preserve notifications arriving after preview', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const id = await user(), other = await user();
    await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
    const add = async (owner, title) => (await db.query("INSERT INTO notifications(user_id,type,title,message) VALUES($1,'system',$2,'Synthetic fixture') RETURNING id", [owner, title])).rows[0].id;
    const a = await add(id, 'Older notice'), b = await add(other, 'Other owner notice');
    const plan = await tools.prepare(db, id, { type: 'app_tool', tool: 'notifications.delete_all', parameters: {}, evidence: 'xoá tất cả thông báo' });
    expect((await db.query('SELECT id FROM notifications WHERE id=$1', [a])).rowCount).toBe(1);
    const fresh = await add(id, 'Newly arrived notice');
    await expect(tools.execute(db, other, plan.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
    await tools.execute(db, id, plan.action.planToken);
    await tools.execute(db, id, plan.action.planToken);
    expect((await db.query('SELECT id FROM notifications WHERE id=ANY($1::bigint[]) ORDER BY id', [[a, b, fresh]])).rows.map(row => String(row.id)))
      .toEqual([b, fresh].sort((a, b) => Number(a) - Number(b)).map(String));
  });
  test('assistant app tools: settings are previews, preserve unrelated preferences and reject stale or revoked requests', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const ai = require('../../src/services/ai/ai-consent.service');
    const id = await user(); await ai.grantAiConsent(db, id);
    const request = patch => ({ type: 'app_tool', tool: 'settings.configure', parameters: patch, evidence: 'đổi cài đặt' });
    const plan = await tools.prepare(db, id, request({ health_feed_enabled: false }));
    expect((await db.query('SELECT health_feed_enabled FROM user_notification_preferences WHERE user_id=$1', [id])).rows[0].health_feed_enabled).not.toBe(false);
    await tools.execute(db, id, plan.action.planToken);
    expect(await tools.execute(db, id, plan.action.planToken)).toMatchObject({ replay: true });
    expect((await db.query('SELECT reminders_enabled,health_feed_enabled FROM user_notification_preferences WHERE user_id=$1', [id])).rows[0])
      .toEqual({ reminders_enabled: true, health_feed_enabled: false });
    const next = await tools.prepare(db, id, request({ reminders_enabled: false }));
    await ai.revokeAiConsent(db, id);
    await expect(tools.execute(db, id, next.action.planToken)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  });
  test('assistant app tools: family sharing is directional and changing alert permission cannot restore revoked health access', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const id = await user(), relative = await user();
    for (const owner of [id, relative]) await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, owner);
    await db.query("UPDATE users SET display_name=CASE WHEN id=$1 THEN 'Synthetic owner' ELSE 'Synthetic relative' END WHERE id=ANY($2::integer[])", [id, [id, relative]]);
    await connect(id, relative);
    const run = async (owner, tool, parameters) => {
      const plan = await tools.prepare(db, owner, { type: 'app_tool', tool, parameters, evidence: 'explicit synthetic request' });
      expect(plan.action).toBeDefined(); return tools.execute(db, owner, plan.action.planToken);
    };
    await run(id, 'family.share', { target: 'Synthetic relative', enabled: false });
    await run(id, 'family.permissions', { target: 'Synthetic relative', changes: { can_receive_alerts: false } });
    let row = (await db.query('SELECT permissions,addressee_can_view_logs FROM user_connections WHERE requester_id=$1 AND addressee_id=$2', [id, relative])).rows[0];
    expect(row.permissions.can_view_logs).toBe(false); expect(row.permissions.can_receive_alerts).toBe(false);
    expect((await tools.prepare(db, id, { type: 'app_tool', tool: 'family.health', parameters: { target: 'Synthetic relative' }, evidence: 'xem sức khoẻ' })).answer).toContain('chưa cho phép');
    await run(relative, 'family.share', { target: 'Synthetic owner', enabled: true });
    row = (await db.query('SELECT permissions,addressee_can_view_logs FROM user_connections WHERE requester_id=$1 AND addressee_id=$2', [id, relative])).rows[0];
    expect(row.addressee_can_view_logs).toBe(true); expect(row.permissions.can_view_logs).toBe(false);
    const forbidden = await tools.prepare(db, relative, { type: 'app_tool', tool: 'family.permissions', parameters: { target: 'Synthetic owner', changes: { can_receive_alerts: true } }, evidence: 'đổi quyền' });
    expect(forbidden.action).toBeUndefined(); expect(forbidden.clarify).toBeTruthy();
  });
  test('assistant app tools: real call settings retain other fields, replay safely, and reject a conflicting manual time change', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const entitlement = require('../../src/services/payment/entitlement.service');
    const id = await user(); await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
    const spy = jest.spyOn(entitlement, 'getEntitlement').mockResolvedValue({ callCenterEnabled: true });
    try {
      const args = { type: 'app_tool', tool: 'calls.configure', parameters: { checkin_time: '09:30' }, evidence: '9 giờ 30 sáng' };
      const plan = await tools.prepare(db, id, args);
      await tools.execute(db, id, plan.action.planToken);
      expect(await tools.execute(db, id, plan.action.planToken)).toMatchObject({ replay: true });
      const current = await require('../../src/services/checkin-call/checkin-call.service').settings(db, id);
      expect(String(current.checkin_time).slice(0, 5)).toBe('09:30'); expect(current.enabled).toBe(false); expect(current.grace_hours).toBe(6);
      const next = await tools.prepare(db, id, { ...args, parameters: { checkin_time: '10:30' } });
      await db.query("UPDATE checkin_call_settings SET checkin_time='11:00' WHERE user_id=$1", [id]);
      await expect(tools.execute(db, id, next.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_TOOL_CONFLICT' });
      const voice = await tools.prepare(db, id, { type: 'app_tool', tool: 'calls.personalize', parameters: { address: 'chu', use_name: true }, evidence: 'gọi chú và dùng tên' });
      await tools.execute(db, id, voice.action.planToken);
      expect((await require('../../src/services/checkin-call/personalization.service').preferences(db, id)).preferences)
        .toMatchObject({ address: 'chu', use_name: true, use_health: false, weather_enabled: false });
    } finally { spy.mockRestore(); }
  });
  test('assistant app tools: renaming and notes retain dose history and medicine group companions', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const id = await user(); await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, id);
    const first = (await med.createItem(db, id, id, { display_name: 'Synthetic A', kind: 'MEDICINE', source: 'VOICE', confirmed: true })).item;
    const second = (await med.createItem(db, id, id, { display_name: 'Synthetic B', kind: 'MEDICINE', source: 'VOICE', confirmed: true })).item;
    const schedule = await med.saveSchedule(db, id, id, null, { time_local: '07:00', item_ids: [first.id, second.id] });
    const rename = await tools.prepare(db, id, { type: 'app_tool', tool: 'medication.rename', parameters: { target: 'Synthetic A', name: 'Synthetic renamed' }, evidence: 'rename synthetic' });
    await tools.execute(db, id, rename.action.planToken);
    const note = await tools.prepare(db, id, { type: 'app_tool', tool: 'medication.configure', parameters: { target: 'Synthetic renamed', time: '07:00', changes: { note: 'Theo hướng dẫn bác sĩ' } }, evidence: 'change note' });
    await tools.execute(db, id, note.action.planToken);
    expect(await tools.execute(db, id, note.action.planToken)).toMatchObject({ replay: true });
    const context = await require('../../src/services/assistant/medication-assistant.service').contextForPlan(db, id);
    expect(context.items.find(item => item.id === first.id).name).toBe('Synthetic renamed');
    expect(context.schedules[0].item_ids.sort()).toEqual([first.id, second.id].sort());
    expect(context.schedules[0].note).toBe('Theo hướng dẫn bác sĩ');
    const stale = await tools.prepare(db, id, { type: 'app_tool', tool: 'medication.configure', parameters: { target: 'Synthetic renamed', time: '07:00', changes: { note: 'Ghi chú trong bản xem trước' } }, evidence: 'change note' });
    await med.saveSchedule(db, id, id, schedule.schedule.id, { time_local: '07:00', item_ids: [first.id, second.id], note: 'Ghi chú vừa sửa bằng tay' });
    await expect(tools.execute(db, id, stale.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_TOOL_CONFLICT' });
    expect((await require('../../src/services/assistant/medication-assistant.service').contextForPlan(db, id)).schedules[0].note).toBe('Ghi chú vừa sửa bằng tay');
  });
  test('assistant app tools: a new unfinished interview does not hide the complete previous conclusion or another owner privacy', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const id = await user(), other = await user(), full = 'Kết luận và lời khuyên đầy đủ. '.repeat(140);
    const session = (await db.query("INSERT INTO health_checkins(user_id,session_date,initial_status,current_status,flow_state) VALUES($1,CURRENT_DATE,'tired','tired','follow_up') RETURNING id", [id])).rows[0];
    await db.query(`INSERT INTO health_checkin_occurrences(checkin_id,user_id,session_date,initial_status,current_status,flow_state,started_at,completed_at,snapshot_updated_at,triage_summary)
      VALUES($1,$2,CURRENT_DATE,'tired','tired','monitoring',now()-interval '1 hour',now()-interval '30 minutes',now()-interval '30 minutes',$3)`, [session.id, id, full]);
    const result = await tools.prepare(db, id, { type: 'app_tool', tool: 'checkin.conclusion', parameters: { speak: true }, evidence: 'đọc kết luận' });
    expect(result.answer).toBe(full); expect(result.speech).toBe(full); expect(result.answer.length).toBeGreaterThan(3000);
    const privateResult = await tools.prepare(db, other, { type: 'app_tool', tool: 'checkin.conclusion', parameters: {}, evidence: 'xem kết luận' });
    expect(privateResult.answer).not.toContain(full.slice(0, 30));
  });
  test('the reward catalog includes profile photos only for accepted greeting recipients', async () => {
    const sender = await user(), relative = await user(), noPhoto = await user(), stranger = await user();
    const avatarUrl = 'https://images.example.test/family.jpg';
    await db.query('UPDATE users SET avatar_url=$1 WHERE id=ANY($2::int[])', [avatarUrl, [relative, stranger]]);
    await connect(relative, sender);
    await connect(sender, noPhoto);

    const response = await request(app).get('/api/mobile/rewards').set(auth(sender)).expect(200);
    expect(response.body.recipients).toEqual([
      expect.objectContaining({ id: relative, avatarUrl }),
      expect.objectContaining({ id: noPhoto, avatarUrl: null }),
    ]);
  });
  test('assistant app tools: sending a greeting resolves the real catalog and one signed request spends coins once', async () => {
    const tools = require('../../src/services/assistant/domain-tools.service');
    const sender = await user(), recipient = await user();
    await require('../../src/services/ai/ai-consent.service').grantAiConsent(db, sender);
    await db.query("UPDATE users SET display_name='Synthetic recipient' WHERE id=$1", [recipient]);
    await connect(sender, recipient); await seedCoins(sender, 100);
    await db.query("UPDATE greeting_templates SET active=TRUE,approved_by='synthetic-test-only',approved_at=NOW() WHERE code='MISS_YOU'");
    const catalog = await coins.catalog(db, sender), template = catalog.templates.find(row => row.code === 'MISS_YOU');
    const plan = await tools.prepare(db, sender, { type: 'app_tool', tool: 'coins.redeem', parameters: { reward: 'GREETING_CARD', recipient: 'Synthetic recipient', template: template.title }, evidence: 'send explicit synthetic card' });
    expect((await coins.today(db, sender)).balance).toBe(100);
    expect(plan.action.label).toContain('Synthetic recipient');
    await tools.execute(db, sender, plan.action.planToken);
    await tools.execute(db, sender, plan.action.planToken);
    expect((await coins.today(db, sender)).balance).toBe(100 - catalog.items.find(row => row.code === 'GREETING_CARD').cost);
    expect((await db.query('SELECT count(*)::int n FROM reward_redemptions WHERE user_id=$1', [sender])).rows[0].n).toBe(1);
    // This scenario verifies preparation and redemption, not background delivery.
    await db.query("DELETE FROM v21_message_outbox WHERE subject_id=$1 AND kind='coin_card'", [sender]);
  });
  async function cardFixture() {
    const sender = await user(),
      recipient = await user();
    await connect(sender, recipient);
    await seedCoins(sender, 100);
    await db.query(
      "UPDATE greeting_templates SET active=TRUE,approved_by='synthetic-test-only',approved_at=NOW() WHERE code='MISS_YOU'"
    );
    const input = {
      request_id: randomUUID(),
      payload: { recipientId: recipient, templateCode: 'MISS_YOU' },
    };
    const result = await coins.redeem(db, sender, 'GREETING_CARD', input);
    return { sender, recipient, input, id: result.redemption.id };
  }
  const forceCardJobDue = () =>
    db.query(
      "UPDATE v21_message_outbox SET next_at=NOW()-INTERVAL '1 second' WHERE kind='coin_card'"
    );
  const cardState = async (id) =>
    (await db.query('SELECT status FROM reward_redemptions WHERE id=$1', [id])).rows[0].status;
  const setQuietClock = (time) =>
    quietHours.getQuietHoursHoldUntil.mockImplementation((n, p, tz) =>
      actualQuietHours.getQuietHoursHoldUntil(n, p, tz, new Date(time))
    );

  test('card waiting overnight does not consume failure attempts or refund; morning retry sends once', async () => {
    setQuietClock('2026-11-06T01:00:00+07:00');
    try {
      const card = await cardFixture();
      pushProvider.sendPushNotification.mockClear();
      for (let i = 0; i < 8; i++) {
        await forceCardJobDue();
        await messages.processMessages(db);
      }
      expect(await cardState(card.id)).toBe('PENDING');
      expect((await coins.today(db, card.sender)).balance).toBe(50);
      expect(pushProvider.sendPushNotification).not.toHaveBeenCalled();
      const job = (await db.query("SELECT * FROM v21_message_outbox WHERE kind='coin_card'"))
        .rows[0];
      expect(job.attempts).toBe(0);
      // Only the quiet-hours clock is replaced. PostgreSQL keeps its real
      // clock, so the durable job must never be rescheduled into the past.
      expect(job.next_at.getTime()).toBeGreaterThanOrEqual(
        new Date('2026-11-06T06:00:00+07:00').getTime()
      );
      setQuietClock('2026-11-06T06:00:00+07:00');
      await db.query(
        "UPDATE notification_push_outbox SET next_attempt_at=NOW()-INTERVAL '1 second'"
      );
      await notificationDelivery.deliverNotification(db, job.notification_id);
      await forceCardJobDue();
      await messages.processMessages(db);
      expect(await cardState(card.id)).toBe('DELIVERED');
      expect(pushProvider.sendPushNotification).toHaveBeenCalledTimes(1);
      expect((await coins.today(db, card.sender)).balance).toBe(50);
    } finally {
      quietHours.getQuietHoursHoldUntil.mockImplementation(actualQuietHours.getQuietHoursHoldUntil);
    }
  });

  test('real exhausted provider attempts refund once and cancel the card push', async () => {
    setQuietClock('2026-11-06T12:00:00+07:00');
    pushProvider.sendPushNotification.mockResolvedValue({ ok: false });
    try {
      const card = await cardFixture();
      for (let i = 0; i < 5; i++) {
        await db.query(
          "UPDATE notification_push_outbox SET next_attempt_at=NOW()-INTERVAL '1 second'"
        );
        await forceCardJobDue();
        await messages.processMessages(db);
      }
      expect(await cardState(card.id)).toBe('REFUNDED');
      expect((await coins.today(db, card.sender)).balance).toBe(100);
      expect(
        (
          await db.query(
            "SELECT o.state FROM notification_push_outbox o JOIN notifications n ON n.id=o.notification_id WHERE n.type='coin_card' AND n.data->>'redemptionId'=$1",
            [card.id]
          )
        ).rows
      ).toEqual([{ state: 'CANCELLED' }]);
      await coins.refund(db, card.id);
      expect((await coins.today(db, card.sender)).balance).toBe(100);
    } finally {
      pushProvider.sendPushNotification.mockResolvedValue({ ok: true });
      quietHours.getQuietHoursHoldUntil.mockImplementation(actualQuietHours.getQuietHoursHoldUntil);
    }
  });

  test('a legacy queued push for an already refunded card cannot deliver', async () => {
    setQuietClock('2026-11-06T01:00:00+07:00');
    try {
      const card = await cardFixture();
      await messages.processMessages(db);
      await coins.refund(db, card.id);
      const job = (
        await db.query("SELECT notification_id FROM v21_message_outbox WHERE kind='coin_card'")
      ).rows[0];
      await db.query(
        "UPDATE notification_push_outbox SET state='RETRY',next_attempt_at=NOW()-INTERVAL '1 second'"
      );
      pushProvider.sendPushNotification.mockClear();
      setQuietClock('2026-11-06T06:00:00+07:00');
      expect(
        (await notificationDelivery.deliverNotification(db, job.notification_id)).skipped
      ).toBe(true);
      expect(pushProvider.sendPushNotification).not.toHaveBeenCalled();
      expect(await cardState(card.id)).toBe('REFUNDED');
    } finally {
      quietHours.getQuietHoursHoldUntil.mockImplementation(actualQuietHours.getQuietHoursHoldUntil);
    }
  });

  test('refund waits for a live delivery lease and never refunds a sent card', async () => {
    setQuietClock('2026-11-06T01:00:00+07:00');
    try {
      const card = await cardFixture();
      await messages.processMessages(db);
      await db.query(
        "UPDATE notification_push_outbox SET state='INFLIGHT',lease_until=NOW()+INTERVAL '1 minute'"
      );
      expect(await coins.refund(db, card.id)).toEqual({ deferred: true });
      expect(await cardState(card.id)).toBe('PENDING');
      expect((await coins.today(db, card.sender)).balance).toBe(50);
      await db.query("UPDATE notification_push_outbox SET state='SENT',lease_until=NULL");
      expect(await coins.refund(db, card.id)).toEqual({ delivered: true });
      expect(await cardState(card.id)).toBe('DELIVERED');
      expect((await coins.today(db, card.sender)).balance).toBe(50);
    } finally {
      quietHours.getQuietHoursHoldUntil.mockImplementation(actualQuietHours.getQuietHoursHoldUntil);
    }
  });

  test('greeting content is snapshotted, retried idempotently, and only sender/connected recipient can open it', async () => {
    const card = await cardFixture();
    const original = (await greetingCards.read(db, card.sender, card.id)).card.template;
    await db.query(
      "UPDATE greeting_templates SET body='New template content' WHERE code='MISS_YOU'"
    );
    expect((await coins.redeem(db, card.sender, 'GREETING_CARD', card.input)).redemption.id).toBe(
      card.id
    );
    expect((await greetingCards.read(db, card.sender, card.id)).card.template).toEqual(original);
    const outsider = await user();
    await expect(greetingCards.read(db, outsider, card.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await greetingCards.open(db, card.sender, card.id);
    expect(await cardState(card.id)).toBe('PENDING');
    // Receiving a family card must work even outside the sender's coin rollout.
    await db.query('UPDATE v21_config SET rollout_user_ids=$1', [[card.sender]]);
    const response = await request(app)
      .post(`/api/mobile/rewards/cards/${card.id}/open`)
      .set(auth(card.recipient))
      .send({})
      .expect(200);
    expect(response.body.card.template).toEqual(original);
    expect(await cardState(card.id)).toBe('DELIVERED');
    await coins.refund(db, card.id);
    expect((await coins.today(db, card.sender)).balance).toBe(50);
    await db.query("UPDATE user_connections SET status='rejected'");
    await expect(greetingCards.read(db, card.recipient, card.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test('delegated greeting collection enables only unapproved defaults and exposes preview copy', async () => {
    await db.query(
      "UPDATE greeting_templates SET body='Editor content',approved_by='fixture-editor',approved_at=NOW() WHERE code='BIRTHDAY'"
    );
    await db.query(
      fs.readFileSync(
        path.join(__dirname, '../../db/migrations/128_greeting_card_collection.sql'),
        'utf8'
      )
    );
    const rows = (await db.query('SELECT * FROM greeting_templates ORDER BY code')).rows;
    expect(rows.find((t) => t.code === 'BIRTHDAY').body).toBe('Editor content');
    expect(rows.find((t) => t.code === 'BIRTHDAY').active).toBe(false);
    expect(
      rows
        .filter((t) => t.active)
        .map((t) => t.code)
        .sort()
    ).toEqual(['MISS_YOU', 'NEW_YEAR']);
    const card = await cardFixture();
    expect(
      (await coins.catalog(db, card.sender)).templates.every((t) => Boolean(t.body && t.body_en))
    ).toBe(true);
  });
  const draftSnapshot = () => ({
    version: 1,
    step: 2,
    items: [
      {
        clientId: randomUUID(),
        display_name: 'Thuốc đang kiểm tra',
        kind: 'MEDICINE',
        source: 'PHOTO_AI',
        confirmed: false,
        anchors: [],
      },
    ],
    meals: { breakfast: '06:30', lunch: '11:30', dinner: '18:00', bedtime: '21:30' },
    slots: [],
    photoMediaId: null,
  });
  test('medication drafts persist encrypted without creating a medicine or a reminder, and retry once safely', async () => {
    const id = await user(),
      draftId = randomUUID(),
      snapshot = draftSnapshot();
    const first = await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 0, snapshot });
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(1);
    const again = await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 0, snapshot });
    expect(again.status).toBe(200);
    expect(again.body.revision).toBe(1);
    const read = await request(app).get('/api/mobile/med-schedules').set(auth(id));
    expect(read.body.draft.snapshot).toEqual(snapshot);
    const row = (
      await db.query('SELECT snapshot_json FROM med_setup_drafts WHERE id=$1', [draftId])
    ).rows[0];
    expect(row.snapshot_json).toMatch(/^asinu:enc:v1:/);
    expect(row.snapshot_json).not.toContain('Thuốc đang');
    expect(
      (await db.query('SELECT 1 FROM med_items WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(0);
    expect(
      (await db.query('SELECT 1 FROM med_schedules WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(0);
  });
  test('deleted drafts cannot return from a delayed writer and new drafts use a new identity', async () => {
    const id = await user(),
      draftId = randomUUID(),
      snapshot = draftSnapshot();
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 0, snapshot })
      .expect(200);
    await request(app)
      .delete(`/api/mobile/medication/draft/${draftId}?revision=1`)
      .set(auth(id))
      .expect(200);
    const stale = await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 1, snapshot });
    expect(stale.status).toBe(409);
    expect(
      (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body.draft
    ).toBeNull();
    expect(
      (await db.query('SELECT snapshot_json FROM med_setup_drafts WHERE id=$1', [draftId])).rows[0]
        .snapshot_json
    ).toBeNull();
    const secondId = randomUUID();
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: secondId, revision: 0, snapshot })
      .expect(200);
    await request(app)
      .delete(`/api/mobile/medication/draft/${secondId}?revision=1`)
      .set(auth(id))
      .expect(200);
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 0, snapshot })
      .expect(409);
  });
  test('draft reads and photos remain scoped to creator and patient, including revoked Care Circle access', async () => {
    const patient = await user(),
      actor = await user(),
      stranger = await user();
    await connect(patient, actor);
    const snapshot = draftSnapshot(),
      draftId = randomUUID();
    await request(app)
      .put(`/api/mobile/medication/draft?patientId=${patient}`)
      .set(auth(actor))
      .send({ id: draftId, revision: 0, snapshot })
      .expect(200);
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(stranger))
      .send({ id: draftId, revision: 0, snapshot })
      .expect(409);
    expect(
      (await db.query('SELECT actor_id FROM med_setup_drafts WHERE id=$1', [draftId])).rows[0]
        .actor_id
    ).toBe(actor);
    expect(
      (await request(app).get(`/api/mobile/med-schedules?patientId=${patient}`).set(auth(patient)))
        .body.draft
    ).toBeNull();
    await request(app)
      .get(`/api/mobile/med-schedules?patientId=${patient}`)
      .set(auth(stranger))
      .expect(403);
    await db.query(
      "UPDATE user_connections SET status='rejected' WHERE (requester_id=$1 AND addressee_id=$2) OR(requester_id=$2 AND addressee_id=$1)",
      [patient, actor]
    );
    await request(app)
      .get(`/api/mobile/med-schedules?patientId=${patient}`)
      .set(auth(actor))
      .expect(403);
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(stranger))
      .send({
        id: randomUUID(),
        revision: 0,
        snapshot: { ...snapshot, photoMediaId: randomUUID() },
      })
      .expect(403);
  });
  test('only a successful confirmed setup consumes its draft, atomically with the schedules', async () => {
    const id = await user(),
      draftId = randomUUID(),
      snapshot = draftSnapshot();
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 0, snapshot })
      .expect(200);
    const body = {
      request_id: randomUUID(),
      draft_id: draftId,
      draft_revision: 1,
      items: [
        { display_name: 'Thuốc đã kiểm tra', kind: 'MEDICINE', source: 'CHIP', confirmed: true },
      ],
      meals: snapshot.meals,
      slots: [{ time_local: '07:00', meal_anchor: 'after_breakfast', item_indexes: [0] }],
    };
    await request(app)
      .post('/api/mobile/medication/setup')
      .set(auth(id))
      .send({ ...body, slots: [{ ...body.slots[0], time_local: '99:99' }] })
      .expect(400);
    expect((await request(app).get('/api/mobile/med-schedules').set(auth(id))).body.draft.id).toBe(
      draftId
    );
    await request(app).post('/api/mobile/medication/setup').set(auth(id)).send(body).expect(200);
    expect(
      (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body.draft
    ).toBeNull();
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 1, snapshot })
      .expect(409);
  });
  test('concurrent edits to one draft reject a stale revision and keep one complete snapshot', async () => {
    const id = await user(),
      draftId = randomUUID(),
      snapshot = draftSnapshot();
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 0, snapshot })
      .expect(200);
    const edits = await Promise.all(
      ['A', 'B'].map((name) =>
        request(app)
          .put('/api/mobile/medication/draft')
          .set(auth(id))
          .send({
            id: draftId,
            revision: 1,
            snapshot: { ...snapshot, items: [{ ...snapshot.items[0], display_name: name }] },
          })
      )
    );
    expect(edits.map((r) => r.status).sort()).toEqual([200, 409]);
    const result = (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body.draft;
    expect(result.revision).toBe(2);
    await request(app)
      .post('/api/mobile/medication/setup')
      .set(auth(id))
      .send({
        request_id: randomUUID(),
        draft_id: draftId,
        draft_revision: 1,
        items: [
          { display_name: 'Tên phiên bản cũ', kind: 'MEDICINE', source: 'CHIP', confirmed: true },
        ],
        meals: snapshot.meals,
        slots: [{ time_local: '07:00', meal_anchor: 'after_breakfast', item_indexes: [0] }],
      })
      .expect(409);
    expect(
      (await db.query('SELECT 1 FROM med_schedules WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(0);

    expect(['A', 'B']).toContain(result.snapshot.items[0].display_name);
  });
  test('multiple independent drafts survive creation, edits and deleting only the selected draft', async () => {
    const id = await user(),
      first = randomUUID(),
      second = randomUUID();
    const snapshots = [draftSnapshot(), draftSnapshot()];
    snapshots[0].items[0].display_name = 'Bản nháp trước';
    snapshots[1].items[0].display_name = 'Đơn mới';
    const created = await Promise.all(
      [first, second].map((draftId, i) =>
        request(app)
          .put('/api/mobile/medication/draft')
          .set(auth(id))
          .send({ id: draftId, revision: 0, snapshot: snapshots[i] })
      )
    );
    expect(created.map((r) => r.status)).toEqual([200, 200]);
    const read = (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body;
    expect(new Set(read.drafts.map((d) => d.id))).toEqual(new Set([first, second]));
    expect(read.draft).toEqual(read.drafts[0]);
    const overview = (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body;
    expect(overview.drafts).toHaveLength(2);
    for (const row of (
      await db.query('SELECT snapshot_json FROM med_setup_drafts WHERE actor_id=$1', [id])
    ).rows)
      expect(row.snapshot_json).toMatch(/^asinu:enc:v1:/);
    await request(app)
      .delete(`/api/mobile/medication/draft/${second}?revision=1`)
      .set(auth(id))
      .expect(200);
    const remaining = (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body
      .drafts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(first);
    expect(remaining[0].snapshot).toEqual(snapshots[0]);
    expect(
      (await db.query('SELECT 1 FROM med_schedules WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(0);
  });
  test('saving a selected draft never consumes a different unfinished plan', async () => {
    const id = await user(),
      first = randomUUID(),
      second = randomUUID(),
      snapshot = draftSnapshot();
    for (const draftId of [first, second])
      await request(app)
        .put('/api/mobile/medication/draft')
        .set(auth(id))
        .send({ id: draftId, revision: 0, snapshot })
        .expect(200);
    await request(app)
      .post('/api/mobile/medication/setup')
      .set(auth(id))
      .send({
        request_id: randomUUID(),
        draft_id: second,
        draft_revision: 1,
        items: [
          { display_name: 'Tên đã xác nhận', kind: 'MEDICINE', source: 'CHIP', confirmed: true },
        ],
        meals: snapshot.meals,
        slots: [{ time_local: '07:30', meal_anchor: 'after_breakfast', item_indexes: [0] }],
      })
      .expect(200);
    const remaining = (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body
      .drafts;
    expect(remaining.map((d) => d.id)).toEqual([first]);
    expect(
      (
        await request(app)
          .get('/api/mobile/med-schedules')
          .set(auth(await user()))
      ).body.drafts
    ).toEqual([]);
  });
  test('a prior unconfirmed scan can be recovered without AI, but never comes back after deleting its draft', async () => {
    const id = await user(),
      media = randomUUID(),
      job = randomUUID();
    await db.query(
      "INSERT INTO med_media(id,patient_user_id,uploader_id,mime_type,payload,byte_length) VALUES($1,$2,$2,'image/png',$3,12)",
      [media, id, med.protect(id, 'med_media.payload', 'fixture-image-base64')]
    );
    await db.query(
      "INSERT INTO med_scan_jobs(id,uploader_id,patient_user_id,media_id,status,result_json,model) VALUES($1,$2,$2,$3,'DONE',$4,'med-gemini')",
      [
        job,
        id,
        media,
        med.protect(
          id,
          'med_scan_jobs.result_json',
          JSON.stringify({
            readable: true,
            items: [
              {
                printed_name: 'Tên từ lần đọc trước',
                display_name: 'Tên từ lần đọc trước',
                kind: 'MEDICINE',
                suggested_slots: [],
              },
            ],
          })
        ),
      ]
    );
    const recovered = await request(app).get('/api/mobile/med-schedules').set(auth(id));
    expect(recovered.status).toBe(200);
    expect(recovered.body.draft.id).toBe(job);
    expect(recovered.body.draft.snapshot.items[0].confirmed).toBe(false);
    expect(recovered.body.draft.photos[media]).toMatch(/^\/api\/mobile\/med-media\//);
    await request(app)
      .delete(`/api/mobile/medication/draft/${job}?revision=1`)
      .set(auth(id))
      .expect(200);
    expect(
      (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body.draft
    ).toBeNull();
    expect(
      (await db.query('SELECT 1 FROM med_schedules WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(0);
  });
  test('drafts retain incomplete clock input but never persist dosage in names or notes', async () => {
    const id = await user(),
      snapshot = draftSnapshot(),
      draftId = randomUUID();
    for (const invalid of [
      { ...snapshot, items: [{ ...snapshot.items[0], display_name: 'Thuốc 500 mg' }] },
      {
        ...snapshot,
        slots: [
          {
            time_local: '07:00',
            meal_anchor: 'after_breakfast',
            item_indexes: [0],
            note: 'Uống 2 viên',
          },
        ],
      },
    ])
      await request(app)
        .put('/api/mobile/medication/draft')
        .set(auth(id))
        .send({ id: draftId, revision: 0, snapshot: invalid })
        .expect(400);
    expect(
      (await db.query('SELECT 1 FROM med_setup_drafts WHERE actor_id=$1', [id])).rowCount
    ).toBe(0);
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({
        id: draftId,
        revision: 0,
        snapshot: { ...snapshot, meals: { ...snapshot.meals, breakfast: '7:' } },
      })
      .expect(200);
  });
  test('paused schedules can be listed and resumed while deleted schedules stay hidden and legacy reads stay active-only', async () => {
    const id = await user(),
      stranger = await user(),
      i = await item(id);
    const paused = (
      await med.saveSchedule(db, id, id, null, {
        time_local: '07:30',
        item_ids: [i.id],
        meal_anchor: 'after_breakfast',
        note: 'Sau bữa sáng',
        active: false,
      })
    ).schedule;
    const deleted = (
      await med.saveSchedule(db, id, id, null, { time_local: '19:00', item_ids: [i.id] })
    ).schedule;
    await med.remove(db, id, id, deleted.id);
    expect((await med.overview(db, id, id)).schedules).toEqual([]);
    const response = await request(app)
      .get('/api/mobile/med-schedules?includePaused=true')
      .set(auth(id));
    expect(response.status).toBe(200);
    expect(response.body.schedules.map((s) => s.id)).toEqual([paused.id]);
    expect(response.body.schedules[0]).toMatchObject({
      active: false,
      note: 'Sau bữa sáng',
      meal_anchor: 'after_breakfast',
    });
    expect(
      (
        await request(app)
          .get(`/api/mobile/med-schedules?patientId=${id}&includePaused=true`)
          .set(auth(stranger))
      ).status
    ).toBe(403);
    const stored = (await db.query('SELECT note FROM med_schedules WHERE id=$1', [paused.id]))
      .rows[0].note;
    expect(stored).not.toContain('Sau bữa sáng');
    await med.saveSchedule(db, id, id, paused.id, {
      time_local: '07:30',
      item_ids: [i.id],
      active: true,
      note: 'Sau bữa sáng',
      meal_anchor: 'after_breakfast',
    });
    expect((await med.overview(db, id, id)).schedules.map((s) => s.id)).toEqual([paused.id]);
  });
  test('a caregiver resuming an approved reminder preserves consent while an unapproved reminder remains pending', async () => {
    const id = await user(),
      child = await user(),
      i = await item(id);
    await connect(id, child);
    const approved = (
      await med.saveSchedule(db, id, id, null, { time_local: '07:30', item_ids: [i.id] })
    ).schedule;
    const body = { time_local: '07:30', item_ids: [i.id], note: 'Sau ăn' };
    await med.saveSchedule(db, child, id, approved.id, { ...body, active: false });
    const resumed = (await med.saveSchedule(db, child, id, approved.id, { ...body, active: true }))
      .schedule;
    expect(resumed.consent_state).toBe('ACTIVE');
    expect(new Date(resumed.consented_at).getTime()).toBe(
      new Date(approved.consented_at).getTime()
    );
    const pending = (
      await med.saveSchedule(db, child, id, null, { time_local: '19:00', item_ids: [i.id] })
    ).schedule;
    const patientPaused = (
      await med.saveSchedule(db, id, id, pending.id, {
        time_local: '19:00',
        item_ids: [i.id],
        active: false,
      })
    ).schedule;
    expect(patientPaused.consent_state).toBe('PENDING');
    const restarted = (
      await med.saveSchedule(db, child, id, pending.id, {
        time_local: '19:00',
        item_ids: [i.id],
        active: true,
      })
    ).schedule;
    expect(restarted.consent_state).toBe('PENDING');
    expect(restarted.consented_at).toBeNull();
    expect(
      (await db.query('SELECT state FROM med_consent_calls WHERE schedule_id=$1', [pending.id]))
        .rows[0].state
    ).toBe('QUEUED');
  });
  test('resuming still enforces four active times and current Care Circle access', async () => {
    const id = await user(),
      child = await user(),
      i = await item(id);
    await connect(id, child);
    for (const time_local of ['07:00', '09:00', '11:00', '13:00'])
      await med.saveSchedule(db, id, id, null, { time_local, item_ids: [i.id] });
    const body = { time_local: '19:00', item_ids: [i.id], active: false };
    const paused = (await med.saveSchedule(db, id, id, null, body)).schedule;
    await expect(
      med.saveSchedule(db, id, id, paused.id, { ...body, active: true })
    ).rejects.toMatchObject({ code: 'MED_SCHEDULE_LIMIT' });
    await db.query(
      "UPDATE user_connections SET status='rejected' WHERE requester_id=$1 AND addressee_id=$2",
      [id, child]
    );
    await expect(med.saveSchedule(db, child, id, paused.id, body)).rejects.toMatchObject({
      code: 'MED_CARE_CIRCLE_REQUIRED',
    });
    expect(
      (await db.query('SELECT active FROM med_schedules WHERE id=$1', [paused.id])).rows[0].active
    ).toBe(false);
  });
  test('setup persists encrypted notes and rejects dosage or long notes before creating schedules', async () => {
    const id = await user();
    const base = {
      items: [
        { display_name: 'Thuốc huyết áp', kind: 'MEDICINE', source: 'CHIP', confirmed: true },
      ],
      meals: { breakfast: '07:00', lunch: '11:30', dinner: '18:00', bedtime: '21:30' },
    };
    for (const note of ['a'.repeat(61), 'Uống 2 viên', '5 mg']) {
      const response = await request(app)
        .post('/api/mobile/medication/setup')
        .set(auth(id))
        .send({
          ...base,
          request_id: randomUUID(),
          slots: [{ time_local: '07:30', item_indexes: [0], note }],
        });
      expect(response.status).toBe(400);
    }
    expect((await med.overview(db, id, id)).schedules).toEqual([]);
    const saved = await med.setup(db, id, id, {
      ...base,
      request_id: randomUUID(),
      slots: [{ time_local: '07:30', item_indexes: [0], note: 'Sau bữa sáng' }],
    });
    expect(saved.schedules[0].note).toBe('Sau bữa sáng');
    const stored = (
      await db.query('SELECT note FROM med_schedules WHERE id=$1', [saved.schedules[0].id])
    ).rows[0].note;
    expect(stored).not.toContain('Sau bữa sáng');
  });
  test('a stale editor cannot restore a deleted schedule or turn it into a paused reminder', async () => {
    const id = await user(),
      i = await item(id);
    const body = { time_local: '07:30', item_ids: [i.id], note: 'Sau ăn', active: true };
    const saved = (await med.saveSchedule(db, id, id, null, body)).schedule;
    await med.remove(db, id, id, saved.id);
    for (const active of [true, false]) {
      await expect(
        med.saveSchedule(db, id, id, saved.id, { ...body, active, note: 'Ghi chú từ màn cũ' })
      ).rejects.toMatchObject({ code: 'MED_SCHEDULE_NOT_FOUND' });
    }
    expect((await med.overview(db, id, id, { includePaused: true })).schedules).toEqual([]);
  });
  test('saving a schedule immediately creates exactly one today dose without dispatching a call', async () => {
    const id = await user();
    const saved = await request(app)
      .post('/api/mobile/medication/setup')
      .set(auth(id))
      .send(
        setupPayload({
          display_name: 'Thuốc đã xác nhận',
          kind: 'MEDICINE',
          source: 'CHIP',
          confirmed: true,
        })
      )
      .expect(200);
    const today = await request(app).get('/api/mobile/med-doses/today').set(auth(id)).expect(200);
    expect(today.body.items).toHaveLength(1);
    expect(today.body.items[0].schedule_id).toBe(saved.body.schedules[0].id);
    expect(today.body.items[0].state).toBe('SCHEDULED');
    await calls.prepare(db, { scheduleIds: [saved.body.schedules[0].id] });
    expect((await med.doses(db, id, id)).items).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM med_call_attempts')).rowCount).toBe(0);
  });
  test('a complete setup appears in both schedules and today before the periodic scheduler runs', async () => {
    const id = await user();
    await request(app)
      .post('/api/mobile/medication/setup')
      .set(auth(id))
      .send({
        request_id: randomUUID(),
        items: [
          { display_name: 'Thuốc đã xác nhận', kind: 'MEDICINE', source: 'CHIP', confirmed: true },
        ],
        meals: draftSnapshot().meals,
        slots: [
          { time_local: '07:30', item_indexes: [0] },
          { time_local: '19:00', item_indexes: [0] },
        ],
      })
      .expect(200);
    expect((await med.overview(db, id, id)).schedules).toHaveLength(2);
    expect((await med.doses(db, id, id)).items.map((d) => d.time_local)).toEqual([
      '07:30',
      '19:00',
    ]);
  });
  test('daily scheduling retains the saved schedule while preparing a separate dose for each date', async () => {
    const id = await user(),
      medicine = await item(id);
    const { schedule } = await med.saveSchedule(db, id, id, null, {
      time_local: '07:30',
      item_ids: [medicine.id],
    });
    const before = (await med.doses(db, id, id)).items[0];
    await db.query(
      "UPDATE med_dose_events SET local_date=local_date-1,scheduled_at=scheduled_at-INTERVAL '1 day',next_attempt_at=next_attempt_at-INTERVAL '1 day' WHERE id=$1",
      [before.id]
    );
    await calls.prepare(db, { scheduleIds: [schedule.id] });
    const today = (await med.doses(db, id, id)).items;
    expect(today).toHaveLength(1);
    expect(today[0].id).not.toBe(before.id);
    expect((await med.overview(db, id, id)).schedules).toHaveLength(1);
    expect(
      (await db.query('SELECT 1 FROM med_dose_events WHERE schedule_id=$1', [schedule.id])).rowCount
    ).toBe(2);
  });
  test('pending consent or disabled reminders cannot prepare an active today dose', async () => {
    const patient = await user(),
      child = await user(),
      medicine = await item(patient);
    await connect(patient, child);
    const { schedule } = await med.saveSchedule(db, child, patient, null, {
      time_local: '07:30',
      item_ids: [medicine.id],
    });
    expect((await med.doses(db, patient, patient)).items).toHaveLength(0);
    await request(app)
      .post(`/api/mobile/med-schedules/${schedule.id}/consent`)
      .set(auth(patient))
      .send({ accept: true })
      .expect(200);
    expect((await med.doses(db, patient, patient)).items).toHaveLength(1);
    const other = await user(),
      otherMedicine = await item(other);
    await db.query(
      'UPDATE user_notification_preferences SET reminders_enabled=FALSE WHERE user_id=$1',
      [other]
    );
    await med.saveSchedule(db, other, other, null, {
      time_local: '19:00',
      item_ids: [otherMedicine.id],
    });
    expect((await med.doses(db, other, other)).items).toHaveLength(0);
  });
  test('a failed multi-slot setup rolls back newly prepared doses along with its schedules and items', async () => {
    const id = await user(),
      medicine = await item(id);
    await med.saveSchedule(db, id, id, null, { time_local: '07:30', item_ids: [medicine.id] });
    await request(app)
      .post('/api/mobile/medication/setup')
      .set(auth(id))
      .send({
        request_id: randomUUID(),
        items: [
          { display_name: 'Đơn chưa lưu', kind: 'MEDICINE', source: 'CHIP', confirmed: true },
        ],
        meals: draftSnapshot().meals,
        slots: [
          { time_local: '08:30', item_indexes: [0] },
          { time_local: '07:30', item_indexes: [0] },
        ],
      })
      .expect(409);
    expect((await med.overview(db, id, id)).schedules).toHaveLength(1);
    expect((await med.doses(db, id, id)).items).toHaveLength(1);
    expect(
      (await db.query('SELECT 1 FROM med_items WHERE patient_user_id=$1', [id])).rowCount
    ).toBe(1);
  });
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
  const setupPayload = (medicine) => ({
    request_id: randomUUID(),
    items: [medicine],
    meals: { breakfast: '06:30', lunch: '11:30', dinner: '18:00', bedtime: '21:30' },
    slots: [{ time_local: '07:30', item_indexes: [0] }],
  });
  test('a stranger cannot read or set patient items/schedules', async () => {
    const parent = await user(),
      stranger = await user();
    await expect(med.overview(db, stranger, parent)).rejects.toMatchObject({ statusCode: 403 });
    await request(app)
      .post('/api/mobile/medication/setup?patientId=' + parent)
      .set(auth(stranger))
      .send(
        setupPayload({ display_name: 'Private', kind: 'MEDICINE', source: 'CHIP', confirmed: true })
      )
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
  test('verified purpose tags require confirmation, are encrypted, and stay within the patient access boundary', async () => {
    const parent = await user(),
      child = await user(),
      stranger = await user();
    await connect(parent, child);
    const sourceUrl = 'https://dhgpharma.com.vn/vi/san-pham/giam-dau-ha-sot/hapacol-650-0';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (url) =>
          new Response(
            String(url).endsWith('/sitemap.xml')
              ? `<urlset><url><loc>${sourceUrl}</loc></url></urlset>`
              : '<div class="field-field-display-title">Hapacol 650</div><div class="field-field-n-p-indication"><div>Chỉ định</div><p>Điều trị các triệu chứng đau. Hạ sốt.</p></div>'
          )
      );
    try {
      const lookup = await request(app)
        .post('/api/mobile/med-items/lookup?patientId=' + parent)
        .set(auth(child))
        .send({ name: 'Hapacol 650', kind: 'MEDICINE' })
        .expect(200);
      expect(lookup.body.tags).toEqual(['fever_reduction', 'pain_relief']);
      expect(
        (await db.query('SELECT 1 FROM med_items WHERE patient_user_id=$1', [parent])).rowCount
      ).toBe(0);
      const body = {
        display_name: 'Hapacol 650',
        kind: 'MEDICINE',
        source: 'CHIP',
        confirmed: true,
        tag_confirmation: { token: lookup.body.token, codes: ['fever_reduction'] },
      };
      await request(app)
        .post('/api/mobile/medication/setup?patientId=' + parent)
        .set(auth(child))
        .send(setupPayload({ ...body, confirmed: false }))
        .expect(400);
      const saved = await request(app)
        .post('/api/mobile/medication/setup?patientId=' + parent)
        .set(auth(child))
        .send(setupPayload(body))
        .expect(200);
      expect(saved.body.schedules).toHaveLength(1);
      const savedItem = (
        await request(app)
          .get('/api/mobile/med-schedules?patientId=' + parent)
          .set(auth(parent))
          .expect(200)
      ).body.items[0];
      expect(savedItem.purpose_tags.codes).toEqual(['fever_reduction']);
      expect(savedItem.tags_json).toBeUndefined();
      const stored = (await db.query('SELECT tags_json FROM med_items WHERE id=$1', [savedItem.id]))
        .rows[0].tags_json;
      expect(stored).toMatch(/^asinu:enc:v1:/);
      expect(stored).not.toContain('fever_reduction');
      const overview = await request(app)
        .get('/api/mobile/med-schedules?patientId=' + parent)
        .set(auth(parent))
        .expect(200);
      expect(overview.body.items[0].purpose_tags.source.url).toBe(sourceUrl);
      await request(app)
        .post('/api/mobile/med-items/lookup?patientId=' + parent)
        .set(auth(stranger))
        .send({ name: 'Hapacol 650', kind: 'MEDICINE' })
        .expect(403);
      await request(app)
        .post('/api/mobile/medication/setup')
        .set(auth(stranger))
        .send(setupPayload(body))
        .expect(400);
      await request(app)
        .post('/api/mobile/medication/setup?patientId=' + parent)
        .set(auth(child))
        .send(setupPayload({ ...body, display_name: 'Hapacol 650 Extra' }))
        .expect(400);
      await request(app)
        .post('/api/mobile/medication/setup?patientId=' + parent)
        .set(auth(child))
        .send(
          setupPayload({
            ...body,
            tag_confirmation: { token: lookup.body.token, codes: ['diabetes'] },
          })
        )
        .expect(400);
      expect(
        (await db.query('SELECT 1 FROM med_items WHERE patient_user_id=$1', [parent])).rowCount
      ).toBe(1);
    } finally {
      fetchMock.mockRestore();
    }
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
  test('dose-first setup reuses medicines across times and adds to an existing time without duplicate rows', async () => {
    const id = await user(),
      a = await item(id),
      b = await item(id);
    const first = (
      await med.saveSchedule(db, id, id, null, {
        time_local: '07:00',
        item_ids: [a.id],
        note: 'Ghi chú cũ',
      })
    ).schedule;
    const body = {
      request_id: randomUUID(),
      merge_existing: true,
      items: [{ id: b.id }],
      meals: draftSnapshot().meals,
      slots: [
        { time_local: '07:00', item_indexes: [0] },
        { time_local: '19:00', item_indexes: [0] },
      ],
    };
    const response = await request(app)
      .post('/api/mobile/medication/setup')
      .set(auth(id))
      .send(body)
      .expect(200);
    expect(response.body.schedules[0].id).toBe(first.id);
    expect(response.body.schedules[0].note).toBe('Ghi chú cũ');
    const overview = await med.overview(db, id, id);
    expect(overview.items).toHaveLength(2);
    expect(overview.schedules).toHaveLength(2);
    expect(new Set(overview.schedules[0].item_ids)).toEqual(new Set([a.id, b.id]));
    expect(overview.schedules[1].item_ids).toEqual([b.id]);
    await request(app).post('/api/mobile/medication/setup').set(auth(id)).send(body).expect(200);
    expect((await med.overview(db, id, id)).schedules).toHaveLength(2);
  });
  test('adding medicine to one of four existing times is allowed, while a fifth time and foreign medicine roll back', async () => {
    const id = await user(),
      a = await item(id),
      stranger = await user(),
      foreign = await item(stranger);
    for (const time_local of ['07:00', '11:00', '15:00', '19:00'])
      await med.saveSchedule(db, id, id, null, { time_local, item_ids: [a.id] });
    const base = {
      merge_existing: true,
      items: [{ display_name: 'Thuốc mới', kind: 'MEDICINE', source: 'CHIP', confirmed: true }],
      meals: draftSnapshot().meals,
    };
    await med.setup(db, id, id, {
      ...base,
      request_id: randomUUID(),
      slots: [{ time_local: '07:00', item_indexes: [0] }],
    });
    const before = await med.overview(db, id, id);
    await expect(
      med.setup(db, id, id, {
        ...base,
        request_id: randomUUID(),
        slots: [{ time_local: '21:00', item_indexes: [0] }],
      })
    ).rejects.toMatchObject({ code: 'MED_SCHEDULE_LIMIT' });
    await expect(
      med.setup(db, id, id, {
        ...base,
        request_id: randomUUID(),
        items: [...base.items, { id: foreign.id }],
        slots: [{ time_local: '07:00', item_indexes: [0, 1] }],
      })
    ).rejects.toMatchObject({ code: 'MED_ITEM_NOT_FOUND' });
    expect((await med.overview(db, id, id)).items).toHaveLength(before.items.length);
    expect((await med.overview(db, id, id)).schedules).toHaveLength(4);
  });
  test('moving one medicine merges into the target, keeps other memberships and replays the same request once', async () => {
    const id = await user(),
      a = await item(id),
      b = await item(id),
      extra = await item(id);
    const source = (
      await med.saveSchedule(db, id, id, null, { time_local: '07:00', item_ids: [a.id, b.id] })
    ).schedule;
    const target = (
      await med.saveSchedule(db, id, id, null, { time_local: '19:00', item_ids: [extra.id] })
    ).schedule;
    const body = { item_id: a.id, time_local: '19:00', request_id: randomUUID() };
    const url = '/api/mobile/med-schedules/' + source.id + '/move-item';
    const responses = await Promise.all([
      request(app).post(url).set(auth(id)).send(body),
      request(app).post(url).set(auth(id)).send(body),
    ]);
    expect(responses.map((row) => row.status)).toEqual([200, 200]);
    expect(responses[0].body.targetScheduleId).toBe(target.id);
    const overview = await med.overview(db, id, id);
    expect(overview.schedules.find((row) => row.id === source.id).item_ids).toEqual([b.id]);
    expect(new Set(overview.schedules.find((row) => row.id === target.id).item_ids)).toEqual(
      new Set([a.id, extra.id])
    );
    expect(overview.items).toHaveLength(3);
    expect(
      (await db.query('SELECT 1 FROM med_setup_receipts WHERE request_id=$1', [body.request_id]))
        .rowCount
    ).toBe(1);
    await request(app)
      .post(url)
      .set(auth(id))
      .send({ ...body, time_local: '18:00' })
      .expect(409);
    await request(app)
      .post(url + '?patientId=' + id)
      .set(auth(await user()))
      .send({ ...body, request_id: randomUUID() })
      .expect(403);
  });
  test('moving the last medicine replaces its group at the four-time cap; a failed split leaves every group unchanged', async () => {
    const id = await user(),
      a = await item(id),
      b = await item(id);
    const source = (
      await med.saveSchedule(db, id, id, null, { time_local: '07:00', item_ids: [a.id] })
    ).schedule;
    for (const time_local of ['11:00', '15:00', '19:00'])
      await med.saveSchedule(db, id, id, null, { time_local, item_ids: [b.id] });
    await med.moveItem(db, id, id, source.id, {
      item_id: a.id,
      time_local: '08:00',
      request_id: randomUUID(),
    });
    const moved = await med.overview(db, id, id);
    expect(moved.schedules).toHaveLength(4);
    const group = moved.schedules.find((row) => row.time_local === '08:00');
    await med.saveSchedule(db, id, id, group.id, { time_local: '08:00', item_ids: [a.id, b.id] });
    await expect(
      med.moveItem(db, id, id, group.id, {
        item_id: a.id,
        time_local: '09:00',
        request_id: randomUUID(),
      })
    ).rejects.toMatchObject({ code: 'MED_SCHEDULE_LIMIT' });
    expect(
      (await med.overview(db, id, id)).schedules.find((row) => row.id === group.id).item_ids.sort()
    ).toEqual([a.id, b.id].sort());
    expect((await med.overview(db, id, id)).schedules).toHaveLength(4);
  });
  test('a family member moving medicine to a new group still requires patient consent', async () => {
    const patient = await user(),
      child = await user(),
      medicine = await item(patient);
    await connect(patient, child);
    const source = (
      await med.saveSchedule(db, patient, patient, null, {
        time_local: '07:00',
        item_ids: [medicine.id],
      })
    ).schedule;
    const result = await med.moveItem(db, child, patient, source.id, {
      item_id: medicine.id,
      time_local: '19:00',
      request_id: randomUUID(),
    });
    const target = (await med.overview(db, child, patient)).schedules.find(
      (row) => row.id === result.targetScheduleId
    );
    expect(target.consent_state).toBe('PENDING');
    expect(
      (await db.query('SELECT 1 FROM med_consent_calls WHERE schedule_id=$1', [target.id])).rowCount
    ).toBe(1);
    expect(
      (await db.query('SELECT 1 FROM med_dose_events WHERE schedule_id=$1', [target.id])).rowCount
    ).toBe(0);
  });
  test('moving medicine never rewrites a taken dose or its encrypted medicine snapshot', async () => {
    const patient = await user(),
      event = await dose(patient);
    await calls.answer(db, patient, event.id, { button: 1, request_id: randomUUID() });
    const before = (
      await db.query('SELECT item_id,display_name FROM med_dose_items WHERE dose_event_id=$1', [
        event.id,
      ])
    ).rows;
    await med.moveItem(db, patient, patient, event.schedule_id, {
      item_id: before[0].item_id,
      time_local: '19:00',
      request_id: randomUUID(),
    });
    expect(
      (await db.query('SELECT state FROM med_dose_events WHERE id=$1', [event.id])).rows[0].state
    ).toBe('TAKEN');
    expect(
      (
        await db.query('SELECT item_id,display_name FROM med_dose_items WHERE dose_event_id=$1', [
          event.id,
        ])
      ).rows
    ).toEqual(before);
  });
  test('dose-first drafts save chosen empty time groups before any medicine and keep existing item identifiers', async () => {
    const id = await user(),
      a = await item(id),
      snapshot = draftSnapshot();
    snapshot.setupFlow = 'dose_first';
    snapshot.step = 1;
    snapshot.items = [];
    snapshot.slots = [{ time_local: '07:00', meal_anchor: null, item_indexes: [] }];
    const draftId = randomUUID();
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 0, snapshot })
      .expect(200);
    snapshot.items = [{ ...draftSnapshot().items[0], existingItemId: a.id }];
    snapshot.slots[0].item_indexes = [0];
    snapshot.step = 3;
    await request(app)
      .put('/api/mobile/medication/draft')
      .set(auth(id))
      .send({ id: draftId, revision: 1, snapshot })
      .expect(200);
    const read = (await request(app).get('/api/mobile/med-schedules').set(auth(id))).body;
    expect(read.draft.snapshot).toEqual(snapshot);
    expect(read.schedules).toHaveLength(0);
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
    // Earlier medication fixtures also enqueue real notifications; the worker
    // deliberately processes only 30 jobs at a time. Drain bounded batches until
    // this card is reached, without bypassing delivery or refund logic.
    for (let batch = 0; batch < 5; batch++) {
      await messages.processMessages(db);
      if ((await coins.today(db, id)).balance === 80) break;
    }
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
  test('a medication check-in in the previous clinical session still earns one reward for the current calendar day', async () => {
    const id = await user(),
      e = await dose(id);
    await calls.answer(db, id, e.id, { button: 1, request_id: randomUUID() });
    // Reproduce the 00:00-05:00 clinical-day offset without changing the DB clock.
    const checkin = require('../../src/services/checkin/checkin.service');
    const previousDay = jest.spyOn(checkin, 'startCheckin').mockImplementation(
      async () =>
        (
          await db.query(
            `INSERT INTO health_checkins(user_id,session_date,initial_status,current_status,flow_state,last_response_at,occurrence_source)
       VALUES($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-1,'fine','fine','monitoring',NOW(),'med_call') RETURNING *`,
            [id]
          )
        ).rows[0]
    );
    try {
      const a = await calls.checkin(db, id, e.id, 'fine'),
        b = await calls.checkin(db, id, e.id, 'fine');
      expect(a.checkinId).toBe(b.checkinId);
      expect((await coins.today(db, id)).balance).toBe(15);
      expect(
        (await db.query("SELECT 1 FROM coin_ledger WHERE user_id=$1 AND reason='CHECKIN'", [id]))
          .rowCount
      ).toBe(1);
    } finally {
      previousDay.mockRestore();
    }
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
  test('coin history serves ten rows per page and never includes another user’s entries', async () => {
    const owner = await user(), other = await user();
    const { rows } = await db.query(
      `INSERT INTO coin_ledger (user_id,delta,reason,ref_id,local_date,expires_at)
       SELECT CASE WHEN n <= 20 THEN $1::int ELSE $2::int END,
         1,'REFUND',gen_random_uuid(),CURRENT_DATE,NOW()+INTERVAL '12 months'
       FROM generate_series(1,21) n RETURNING id, user_id`,
      [owner, other]
    );
    const history = () => request(app).get('/api/mobile/coins/history').set(auth(owner));
    const first = (await history().query({ limit: 10 }).expect(200)).body;
    expect(first.items).toHaveLength(10);
    expect(first.nextBefore).toBe(String(first.items.at(-1).id));
    const second = (await history().query({ limit: 10, before: first.nextBefore }).expect(200)).body;
    expect(second.items).toHaveLength(10);
    expect(second.nextBefore).toBeNull();
    expect([...first.items, ...second.items].map((row) => row.id)).toEqual(
      rows.filter((row) => row.user_id === owner).reverse().map((row) => row.id)
    );
    expect((await history().expect(200)).body).not.toHaveProperty('nextBefore');
    await history().query({ limit: 31 }).expect(400);
  });
  test('coin history paginates earnings and spending separately from refunds and expiry', async () => {
    const owner = await user(), other = await user();
    const { rows: uses } = await db.query(
      `INSERT INTO coin_ledger (user_id,delta,reason,ref_id,local_date)
       SELECT CASE WHEN n <= 12 THEN $1::int ELSE $2::int END,
         -1,'REDEEM',gen_random_uuid(),CURRENT_DATE
       FROM generate_series(1,13) n RETURNING id, user_id`,
      [owner, other]
    );
    const { rows: credits } = await db.query(
      `INSERT INTO coin_ledger (user_id,delta,reason,ref_id,local_date,expires_at)
       SELECT CASE WHEN n=14 THEN $2::int ELSE $1::int END,
         1,CASE WHEN n=13 THEN 'REFUND' ELSE 'CHECKIN' END,
         gen_random_uuid(),CURRENT_DATE,NOW()+INTERVAL '12 months'
       FROM generate_series(1,14) n RETURNING id, user_id, reason`,
      [owner, other]
    );
    await db.query(
      "INSERT INTO coin_ledger (user_id,delta,reason,ref_id,local_date) VALUES($1,-1,'EXPIRE',gen_random_uuid(),CURRENT_DATE)",
      [owner]
    );
    const history = () => request(app).get('/api/mobile/coins/history').set(auth(owner));
    const full = (await history().query({ limit: 10 }).expect(200)).body;
    expect(full.items.some((row) => row.reason === 'REDEEM')).toBe(false);
    const first = (await history().query({ limit: 10, scope: 'usage' }).expect(200)).body;
    expect(first.items).toHaveLength(10);
    const next = (await history().query({
      limit: 10, scope: 'usage', before: first.nextBefore,
    }).expect(200)).body;
    expect(next.items).toHaveLength(2);
    expect(next.nextBefore).toBeNull();
    expect([...first.items, ...next.items].map((row) => row.id)).toEqual(
      uses.filter((row) => row.user_id === owner).reverse().map((row) => row.id)
    );
    const earnedFirst = (await history().query({ limit: 10, scope: 'earned' }).expect(200)).body;
    expect(earnedFirst.items).toHaveLength(10);
    const earnedNext = (await history().query({
      limit: 10, scope: 'earned', before: earnedFirst.nextBefore,
    }).expect(200)).body;
    expect(earnedNext.items).toHaveLength(2);
    expect(earnedNext.nextBefore).toBeNull();
    expect([...earnedFirst.items, ...earnedNext.items].map((row) => row.id)).toEqual(
      credits.filter((row) => row.user_id === owner && row.reason === 'CHECKIN')
        .reverse().map((row) => row.id)
    );
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
  test.each(['remove', 'meals', 'item'])(
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
  test('SRS EA9/EA12: family alerts default to problems only and respect Care Circle permissions', async () => {
    const parent = await user(),
      child = await user(),
      muted = await user();
    await connect(parent, child);
    await connect(parent, muted);
    await db.query(
      'UPDATE user_connections SET permissions=permissions||\'{"can_receive_alerts":false}\'::jsonb WHERE requester_id=$1 AND addressee_id=$2',
      [parent, muted]
    );
    expect((await med.overview(db, child, parent)).problemsOnly).toBe(true);
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
  test('an old family preference cannot enable or deliver successful-dose alerts', async () => {
    const parent = await user(),
      child = await user();
    await connect(parent, child);
    await db.query(
      'INSERT INTO med_family_preferences(caregiver_id,patient_user_id,problems_only) VALUES($1,$2,FALSE)',
      [child, parent]
    );
    expect((await med.overview(db, child, parent)).problemsOnly).toBe(true);

    const endpoint = '/api/mobile/medication/family-preferences?patientId=' + parent;
    const legacyEnable = await request(app)
      .put(endpoint)
      .set(auth(child))
      .send({ problems_only: true });
    expect(legacyEnable.status).toBe(200);
    expect(legacyEnable.body.problems_only).toBe(true);
    const legacyDisable = await request(app)
      .put(endpoint)
      .set(auth(child))
      .send({ problems_only: false });
    expect(legacyDisable.status).toBe(409);
    expect(legacyDisable.body.code).toBe('MED_FAMILY_ALERTS_FIXED');

    const event = await dose(parent);
    await calls.answer(db, parent, event.id, { button: 1, request_id: randomUUID() });
    expect((await db.query(
      "SELECT 1 FROM v21_message_outbox WHERE subject_id=$1 AND kind='med_result'",
      [parent]
    )).rowCount).toBe(0);
    expect(await notificationDelivery.reserveNotification(db, {
      userId: child,
      type: 'med_result',
      title: 'Asinu',
      body: 'Confirmed medication',
      data: { patientId: parent, doseId: event.id, state: 'TAKEN' },
    })).toBeNull();
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
    const originalTime = (await calls.detail(db, id, old.id)).event.time_local;
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
    expect((await calls.detail(db, id, old.id)).event.time_local).toBe(originalTime);
    expect((await med.doses(db, id, id)).items.find((e) => e.id === old.id).time_local).toBe(
      originalTime
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
  test('an untouched future dose changes to the newly confirmed time without changing an already started reminder', async () => {
    const id = await user(),
      medicine = await item(id);
    const { schedule } = await med.saveSchedule(db, id, id, null, {
      time_local: '07:30',
      item_ids: [medicine.id],
    });
    const old = (await med.doses(db, id, id)).items[0];
    await db.query(
      "UPDATE med_dose_events SET scheduled_at=NOW()+INTERVAL '1 hour',next_attempt_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [old.id]
    );
    await med.saveSchedule(db, id, id, schedule.id, {
      time_local: '08:30',
      item_ids: [medicine.id],
    });
    const revised = (await med.doses(db, id, id)).items;
    expect(revised).toHaveLength(1);
    expect(revised[0].id).not.toBe(old.id);
    expect(revised[0].time_local).toBe('08:30');
    await db.query("UPDATE med_dose_events SET state='CALLING',attempt_count=1 WHERE id=$1", [
      revised[0].id,
    ]);
    await med.saveSchedule(db, id, id, schedule.id, {
      time_local: '09:30',
      item_ids: [medicine.id],
    });
    const kept = (await med.doses(db, id, id)).items;
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(revised[0].id);
    expect(kept[0].time_local).toBe('08:30');
    expect(kept[0].state).toBe('CALLING');
    expect((await med.overview(db, id, id)).schedules[0].time_local).toBe('09:30');
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
