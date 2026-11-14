'use strict';

const { createHash, randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const c = require('../v21/common');
const medication = require('../v21/medication.service');
const { time } = require('../v21/medication.policy');
const { hasAiConsent } = require('../ai/ai-consent.service');

const audience = 'asinu:assistant-medication';
const evidence = z.string().trim().min(1).max(3000);
const createSchema = z.object({
  type: z.literal('medication_create'), name: medication.itemSchema.shape.display_name,
  times: z.array(time).min(1).max(4).refine(values => new Set(values).size === values.length),
  evidence,
}).strict();
const moveSchema = z.object({
  type: z.literal('medication_move'), medicine_ref: z.string().regex(/^m\d+$/),
  schedule_ref: z.string().regex(/^s\d+$/), time_local: time, evidence,
}).strict();
const stateSchema = z.object({ type: z.literal('medication_state'), schedule_ref: z.string().regex(/^s\d+$/),
  state: z.enum(['pause', 'resume', 'delete']), evidence }).strict();
const answerSchema = z.object({ type: z.literal('medication_answer'), dose_ref: z.string().regex(/^d\d+$/),
  answer: z.enum(['taken', 'skipped', 'out_of_meds']), evidence }).strict();
const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').trim();
const isMedication = action => ['medication_create', 'medication_move', 'medication_state', 'medication_answer'].includes(action.type);
const fail = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const canAnswer = dose => !!dose && !['TAKEN', 'SKIPPED', 'OUT_OF_MEDS', 'CANCELLED'].includes(dose.state) &&
  Date.now() >= new Date(dose.scheduled_at).getTime() && Date.now() - new Date(dose.scheduled_at).getTime() <= 2 * 3600000;
const compact = text => normalize(text).replace(/\s+/g, ' ');
function policyQuestion(actions, request, context, lang) {
  if (!Array.isArray(actions)) return;
  const source = compact(`${request.clarification?.original || ''} ${request.text}`);
  const daily = /\b(moi ngay|hang ngay|ngay nao cung|hang sang|hang toi|moi sang|moi toi|moi dem|daily|every day|every morning|every evening)\b/.test(source) ||
    (/\b(moi ngay|hang ngay|daily|every day)\b/.test(compact(request.clarification?.question || '')) &&
      /^(dung( roi)?|vang|co|u|ok(ay)?|duoc|yes( please)?)[.! ]*$/.test(compact(request.text)));
  for (const action of actions) {
    if (action.type === 'medication_create') {
      if (!daily) return lang === 'en' ? 'Would you like this medication reminder every day?'
        : 'Bạn muốn mình nhắc lịch uống thuốc này hằng ngày phải không?';
      const item = context.items.find(item => normalize(item.name) === normalize(action.name || ''));
      if (item && Array.isArray(action.times)) {
        const existing = context.schedules.filter(row => row.active !== false && row.item_ids.includes(item.id));
        if (action.times.every(time => existing.some(row => row.time === time)))
          return lang === 'en' ? `${item.name} already has those daily reminders. Would you like to change a time?`
            : `${item.name} đã có lịch nhắc hằng ngày vào giờ đó rồi. Bạn muốn đổi giờ nào không?`;
        if (existing.length && !/\b(them|tao moi|bo sung|add|new|another)\b/.test(source))
          return lang === 'en' ? `${item.name} has reminders at ${existing.map(row => row.time).join(', ')}. Would you like to add another time or move an existing reminder?`
            : `${item.name} đang có lịch nhắc lúc ${existing.map(row => row.time).join(', ')}. Bạn muốn thêm giờ nhắc mới hay đổi giờ đang có?`;
      }
    } else if (action.type === 'medication_move' && !/\b(doi|doi lai|doi gio|doi lich|chuyen|sua|thay|dieu chinh|som hon|muon hon|tre hon|move|change|reschedule|shift|later|earlier)\b/.test(source) &&
      !(/\b(them|doi|add|move)\b/.test(compact(request.clarification?.question || '')) && /^(doi|move|chuyen)/.test(compact(request.text)))) {
      return lang === 'en' ? 'Would you like to add a new medication reminder or move an existing one?'
        : 'Bạn muốn thêm một lịch nhắc thuốc mới hay đổi giờ nhắc đang có?';
    }
    if (['medication_state', 'medication_answer'].includes(action.type)) {
      const row = action.type === 'medication_state' ? context.schedules[Number(action.schedule_ref?.slice(1)) - 1]
        : context.doses?.[Number(action.dose_ref?.slice(1)) - 1];
      const names = (row?.item_ids || []).map(id => context.items.find(item => item.id === id)?.name).filter(Boolean);
      const affirmative = /^(dung( roi)?|vang|co|u|ok(ay)?|duoc|yes( please)?)[.! ]*$/.test(compact(request.text));
      const questionNames = compact(request.clarification?.question || '');
      if (names.length > 1 && !names.every(name => source.includes(compact(name))) &&
        !/\b(tat ca|ca nhom|ca khung|all|entire group)\b/.test(source) && !(affirmative && names.every(name => questionNames.includes(compact(name)))))
        return lang === 'en' ? `This reminder includes ${names.join(', ')}. Do you want to apply that to all of them?`
          : `Lịch này gồm ${names.join(', ')}. Bạn muốn áp dụng thao tác vừa nói cho tất cả các thuốc này phải không?`;
    }
  }
}

// Read only the authenticated person's active medications. In particular, do
// not use overview(): its legacy draft recovery can create records during a read.
async function readContext(db, userId) {
  await c.patientAccess(db, userId, userId, { selfOnly: true });
  await c.assertFeature(db, userId, 'medication');
  if (process.env.HEALTH_FIELD_ENCRYPTION_ENABLED !== 'true') throw fail('MED_ENCRYPTION_REQUIRED', 503);
  const items = (await db.query(
    'SELECT * FROM med_items WHERE patient_user_id=$1 AND active ORDER BY id', [userId]
  )).rows.map(row => ({ id: row.id, name: medication.reveal(userId, 'med_items.display_name', row.display_name), kind: row.kind }));
  const schedules = (await db.query(
    `SELECT s.*,COALESCE(array_agg(si.item_id ORDER BY si.item_id) FILTER(WHERE si.item_id IS NOT NULL),'{}') item_ids
     FROM med_schedules s LEFT JOIN med_schedule_items si ON si.schedule_id=s.id
     WHERE s.patient_user_id=$1 AND s.consent_state<>'DECLINED' AND (s.active OR COALESCE(
       (SELECT a.action FROM med_schedule_audit a WHERE a.schedule_id=s.id ORDER BY a.id DESC LIMIT 1),'created')<>'deleted')
     GROUP BY s.id ORDER BY s.id`, [userId]
  )).rows.map(row => ({ id: row.id, time: String(row.time_local).slice(0, 5), revision: Number(row.revision),
    item_ids: row.item_ids, consent: row.consent_state, active: row.active, anchor: row.meal_anchor,
    note: medication.reveal(userId, 'med_schedules.note', row.note) || '' }));
  const doses = (await db.query(`SELECT e.id,e.state,e.scheduled_at,to_char(e.scheduled_at AT TIME ZONE e.timezone,'HH24:MI') time,
    COALESCE(array_agg(di.item_id) FILTER(WHERE di.item_id IS NOT NULL),'{}') item_ids
    FROM med_dose_events e LEFT JOIN med_dose_items di ON di.dose_event_id=e.id WHERE e.patient_user_id=$1
    AND e.local_date=(now() AT TIME ZONE e.timezone)::date AND e.state<>'CANCELLED' GROUP BY e.id ORDER BY e.scheduled_at`, [userId])).rows;
  return { available: true, items, schedules, doses };
}

async function contextForPlan(db, userId) {
  if (!db || !userId) return { available: false, items: [], schedules: [] };
  try { return await readContext(db, userId); }
  catch (error) {
    if (['V21_FEATURE_DISABLED', 'MED_ENCRYPTION_REQUIRED'].includes(error.code))
      return { available: false, items: [], schedules: [] };
    throw error;
  }
}
function modelContext(context) {
  return { available: context.available, frequency: 'daily',
    medicines: context.items.map((item, i) => ({ ref: `m${i + 1}`, name: item.name })),
    schedules: context.schedules.map((schedule, i) => ({ ref: `s${i + 1}`, time: schedule.time, active: schedule.active !== false,
      medicines: schedule.item_ids.map(id => `m${context.items.findIndex(item => item.id === id) + 1}`) })),
    doses: (context.doses || []).map((dose, i) => ({ ref: `d${i + 1}`, time: dose.time, state: dose.state, canAnswer: canAnswer(dose),
      medicines: dose.item_ids.map(id => `m${context.items.findIndex(item => item.id === id) + 1}`) })) };
}
const digest = context => createHash('sha256').update(JSON.stringify({ ...context, doses: undefined })).digest('hex');
function validateAction(action, context, source = action.evidence) {
  if (!context?.available) return false;
  if (action.type === 'medication_state') {
    const schedule = context.schedules[Number(action.schedule_ref.slice(1)) - 1];
    return !!schedule && schedule.consent === 'ACTIVE';
  }
  if (action.type === 'medication_answer') return canAnswer(context.doses?.[Number(action.dose_ref.slice(1)) - 1]);
  if (action.type === 'medication_create') {
    if (!normalize(source).includes(normalize(action.name))) return false;
    const matches = context.items.filter(item => normalize(item.name) === normalize(action.name));
    return matches.length <= 1;
  }
  const item = context.items[Number(action.medicine_ref.slice(1)) - 1];
  const schedule = context.schedules[Number(action.schedule_ref.slice(1)) - 1];
  return !!item && !!schedule && schedule.active !== false && schedule.consent === 'ACTIVE' && schedule.item_ids.includes(item.id);
}

function prepare(actions, context, userId, source) {
  if (!process.env.JWT_SECRET) throw fail('APP_ASSISTANT_UNAVAILABLE', 503);
  const operations = [], changes = [], seen = new Set();
  for (const action of actions.filter(isMedication)) {
    if (!validateAction(action, context, source)) throw fail('APP_ASSISTANT_INVALID_REQUEST', 400);
    if (action.type === 'medication_create') {
      const item = context.items.find(item => normalize(item.name) === normalize(action.name));
      const key = item?.id || normalize(action.name);
      if (seen.has(key)) throw fail('APP_ASSISTANT_INVALID_REQUEST', 400);
      seen.add(key);
      operations.push({ kind: 'create', name: action.name, item_id: item?.id, times: action.times });
      changes.push({ operation: 'create', name: action.name, times: action.times });
    } else if (action.type === 'medication_move') {
      const item = context.items[Number(action.medicine_ref.slice(1)) - 1];
      const schedule = context.schedules[Number(action.schedule_ref.slice(1)) - 1];
      const key = `${item.id}:${schedule.id}`;
      if (seen.has(key) || seen.has(item.id)) throw fail('APP_ASSISTANT_INVALID_REQUEST', 400);
      seen.add(key);
      operations.push({ kind: 'move', item_id: item.id, schedule_id: schedule.id, time_local: action.time_local, request_id: randomUUID() });
      changes.push({ operation: 'move', name: item.name, times: [action.time_local], previousTime: schedule.time });
    } else {
      const answer = action.type === 'medication_answer';
      const row = answer ? context.doses[Number(action.dose_ref.slice(1)) - 1] : context.schedules[Number(action.schedule_ref.slice(1)) - 1];
      const key = `${answer ? 'dose' : 'state'}:${row.id}`;
      if (seen.has(key)) throw fail('APP_ASSISTANT_INVALID_REQUEST', 400);
      seen.add(key);
      operations.push(answer ? { kind: 'answer', dose_id: row.id, button: { taken: 1, skipped: 2, out_of_meds: 3 }[action.answer], request_id: randomUUID() }
        : { kind: 'state', schedule_id: row.id, state: action.state });
      changes.push({ operation: answer ? action.answer : action.state,
        name: row.item_ids.map(id => context.items.find(item => item.id === id)?.name).filter(Boolean).join(', '), times: [row.time] });
    }
  }
  if (!operations.length) return null;
  const planToken = jwt.sign({ kind: 'medication', snapshot: digest(context), operations }, process.env.JWT_SECRET,
    { algorithm: 'HS256', audience, subject: String(userId), jwtid: randomUUID(), expiresIn: '10m' });
  return { type: 'medication', changes, planToken };
}

async function execute(pool, userId, token) {
  let plan;
  try {
    plan = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], audience, subject: String(userId), ignoreExpiration: true });
    if (plan.kind !== 'medication' || !z.string().uuid().safeParse(plan.jti).success ||
      !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 5 || !Number.isFinite(plan.exp)) throw Error('invalid');
  } catch { throw fail('APP_ASSISTANT_PLAN_EXPIRED'); }
  const fingerprint = createHash('sha256').update(token).digest('hex');
  return c.transaction(pool, async db => {
    await c.lockPatient(db, userId);
    await c.patientAccess(db, userId, userId, { selfOnly: true });
    await db.query('SELECT user_id FROM user_ai_consents WHERE user_id=$1 FOR SHARE', [userId]);
    if (!(await hasAiConsent(db, userId))) throw fail('AI_CONSENT_REQUIRED', 403);
    const receipt = (await db.query('SELECT * FROM med_setup_receipts WHERE actor_id=$1 AND request_id=$2', [userId, plan.jti])).rows[0];
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw fail('MED_REQUEST_CHANGED');
      return { ...JSON.parse(medication.reveal(userId, 'med_setup_receipts.result_json', receipt.result_json)), replay: true };
    }
    if (Date.now() >= plan.exp * 1000) throw fail('APP_ASSISTANT_PLAN_EXPIRED');
    const context = await readContext(db, userId);
    if (digest(context) !== plan.snapshot) throw fail('APP_ASSISTANT_MEDICATION_CONFLICT');
    const results = [];
    for (const operation of plan.operations) {
      if (operation.kind === 'move') {
        results.push(await medication.moveItem(db, userId, userId, operation.schedule_id, {
          item_id: operation.item_id, time_local: operation.time_local, request_id: operation.request_id,
        }));
      } else if (operation.kind === 'create') {
        const item = operation.item_id ? { id: operation.item_id } : (await medication.createItem(db, userId, userId, {
          display_name: operation.name, kind: 'MEDICINE', source: 'VOICE', confirmed: true,
        })).item;
        for (const localTime of operation.times) {
          // Merge a medicine into an existing time, preserving its other drugs,
          // note and meal association, just like the manual setup flow.
          const latest = await readContext(db, userId);
          const schedule = latest.schedules.find(row => row.active !== false && row.time === localTime && row.consent === 'ACTIVE');
          if (schedule?.item_ids.includes(item.id)) continue;
          results.push(await medication.saveSchedule(db, userId, userId, schedule?.id || null, {
            time_local: localTime, item_ids: [...new Set([...(schedule?.item_ids || []), item.id])],
            meal_anchor: schedule?.anchor || null, note: schedule?.note || '',
          }));
        }
      } else if (operation.kind === 'state') {
        const row = context.schedules.find(row => row.id === operation.schedule_id);
        if (!row) throw fail('APP_ASSISTANT_MEDICATION_CONFLICT');
        results.push(operation.state === 'delete' ? await medication.remove(db, userId, userId, row.id)
          : await medication.saveSchedule(db, userId, userId, row.id, {
            time_local: row.time, item_ids: row.item_ids, meal_anchor: row.anchor, note: row.note, active: operation.state === 'resume',
          }));
      } else if (operation.kind === 'answer') {
        const result = await require('../v21/medication-calls.service').answer(db, userId, operation.dose_id, {
          button: operation.button, request_id: operation.request_id,
        });
        const expected = { 1: 'TAKEN', 2: 'SKIPPED', 3: 'OUT_OF_MEDS' }[operation.button];
        if (result.answerWindowClosed || result.event?.state !== expected) throw fail('APP_ASSISTANT_MEDICATION_CONFLICT');
        results.push(result);
      } else throw fail('APP_ASSISTANT_INVALID_REQUEST', 400);
    }
    const result = { status: 'applied', count: results.length };
    await db.query('INSERT INTO med_setup_receipts(actor_id,request_id,patient_user_id,fingerprint,result_json) VALUES($1,$2,$3,$4,$5)',
      [userId, plan.jti, userId, fingerprint, medication.protect(userId, 'med_setup_receipts.result_json', JSON.stringify(result))]);
    return result;
  });
}

module.exports = { createSchema, moveSchema, stateSchema, answerSchema, isMedication, contextForPlan, modelContext, validateAction, policyQuestion, prepare, execute };
