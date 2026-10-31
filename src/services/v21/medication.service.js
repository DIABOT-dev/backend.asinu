'use strict';
const c = require('./common'),
  p = require('./medication.policy');
const {
  encryptHealthField: encrypt,
  decryptHealthField: decrypt,
} = require('../../security/health-field-encryption');
function requireEncryption() {
  if (process.env.HEALTH_FIELD_ENCRYPTION_ENABLED !== 'true')
    throw c.error('MED_ENCRYPTION_REQUIRED', 503);
}
const protect = (user, field, value) =>
  value == null ? null : encrypt(user, field, String(value));
const reveal = (user, field, value) => decrypt(user, field, value);
const noDose = (text) =>
  !/(?:\d\s*(?:mg|mcg|µg|ml|iu|g|u|units?)\b|\b(?:liều|dosage)\b|\d\s*(?:viên|tablets?|capsules?)\b)/iu.test(
    text
  );
const nameSchema = c.z.string().trim().min(1).max(30).refine(noDose);
const itemSchema = c.z
  .object({
    display_name: nameSchema,
    printed_name: c.z.string().trim().max(120).refine(noDose).nullable().optional(),
    kind: c.z.enum(['MEDICINE', 'SUPPLEMENT']),
    source: c.z.enum(['PHOTO_AI', 'CHIP', 'VOICE']),
    photo_media_id: c.uuid.nullable().optional(),
    confirmed: c.z.literal(true),
  })
  .strict();
const scheduleSchema = c.z
  .object({
    time_local: p.time,
    meal_anchor: c.z.enum(p.anchors).nullable().optional(),
    note: c.z.string().trim().max(60).refine(noDose).optional(),
    item_ids: c.z
      .array(c.uuid)
      .min(1)
      .max(20)
      .refine((a) => new Set(a).size === a.length),
    active: c.z.boolean().default(true),
  })
  .strict();
const mealSchema = c.z
  .object({ breakfast: p.time, lunch: p.time, dinner: p.time, bedtime: p.time })
  .strict();
function publicItem(row) {
  return {
    ...row,
    display_name: reveal(row.patient_user_id, 'med_items.display_name', row.display_name),
    printed_name: reveal(row.patient_user_id, 'med_items.printed_name', row.printed_name),
  };
}
function publicSchedule(row) {
  return {
    ...row,
    time_local: String(row.time_local).slice(0, 5),
    note: reveal(row.patient_user_id, 'med_schedules.note', row.note),
    pushOnly: p.minute(String(row.time_local)) < 420 || p.minute(String(row.time_local)) >= 1260,
  };
}
async function patients(db, actor) {
  const rows = (
    await db.query(
      `SELECT id,COALESCE(full_name,display_name) name FROM users WHERE deleted_at IS NULL AND
 (id=$1 OR id IN(SELECT CASE WHEN requester_id=$1 THEN addressee_id ELSE requester_id END FROM user_connections WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$1)))
 AND v21_allowed(id,'medication') ORDER BY CASE WHEN id=$1 THEN 0 ELSE 1 END,id`,
      [actor]
    )
  ).rows;
  return { patients: rows };
}
async function overview(db, actor, patient) {
  patient = await c.patientAccess(db, actor, patient);
  await c.assertFeature(db, patient, 'medication');
  requireEncryption();
  const [items, schedules, meals, profile] = await Promise.all([
    db.query('SELECT * FROM med_items WHERE patient_user_id=$1 AND active ORDER BY created_at', [
      patient,
    ]),
    db.query(
      `SELECT s.*,COALESCE(array_agg(si.item_id) FILTER(WHERE si.item_id IS NOT NULL),'{}') item_ids FROM med_schedules s
   LEFT JOIN med_schedule_items si ON si.schedule_id=s.id WHERE s.patient_user_id=$1 AND s.active GROUP BY s.id ORDER BY time_local`,
      [patient]
    ),
    db.query('SELECT * FROM user_meal_times WHERE user_id=$1', [patient]),
    db.query('SELECT medical_conditions FROM user_onboarding_profiles WHERE user_id=$1', [patient]),
  ]);
  const prefs = (
    await db.query('SELECT reminders_enabled FROM user_notification_preferences WHERE user_id=$1', [
      patient,
    ])
  ).rows[0];
  const familyPrefs = (
    await db.query(
      'SELECT problems_only FROM med_family_preferences WHERE caregiver_id=$1 AND patient_user_id=$2',
      [actor, patient]
    )
  ).rows[0];
  return {
    remindersEnabled: prefs?.reminders_enabled !== false,
    problemsOnly: !!familyPrefs?.problems_only,
    patientId: patient,
    items: items.rows.map(publicItem),
    schedules: schedules.rows.map(publicSchedule),
    meals: meals.rows[0] || {
      breakfast: '06:30',
      lunch: '11:30',
      dinner: '18:00',
      bedtime: '21:30',
    },
    conditions: profile.rows[0]?.medical_conditions || [],
    self: Number(actor) === patient,
    flags: await c.config(db, patient),
  };
}
async function createItem(pool, actor, patient, body) {
  patient = await c.patientAccess(pool, actor, patient);
  await c.assertFeature(pool, patient, 'medication');
  requireEncryption();
  const x = itemSchema.parse(body);
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    await c.patientAccess(db, actor, patient);
    if (
      x.photo_media_id &&
      !(
        await db.query('SELECT 1 FROM med_media WHERE id=$1 AND patient_user_id=$2', [
          x.photo_media_id,
          patient,
        ])
      ).rowCount
    )
      throw c.error('MED_PHOTO_NOT_FOUND', 404);
    const r = (
      await db.query(
        `INSERT INTO med_items(id,patient_user_id,display_name,printed_name,kind,source,photo_media_id)
  VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          c.randomUUID(),
          patient,
          protect(patient, 'med_items.display_name', x.display_name),
          protect(patient, 'med_items.printed_name', x.printed_name),
          x.kind,
          x.source,
          x.photo_media_id || null,
        ]
      )
    ).rows[0];
    return { item: publicItem(r) };
  });
}
async function scheduleAudit(db, patient, actor, id, action, before, after, notify = true) {
  await db.query(
    `INSERT INTO med_schedule_audit(schedule_id,patient_user_id,actor_user_id,action,before_json,after_json)
 VALUES($1,$2,$3,$4,$5,$6)`,
    [
      id,
      patient,
      actor,
      action,
      protect(patient, 'med_schedule_audit.before_json', JSON.stringify(before)),
      protect(patient, 'med_schedule_audit.after_json', JSON.stringify(after)),
    ]
  );
  if (notify) await notifySchedule(db, patient, actor, id, action, after);
}
async function notifySchedule(db, patient, actor, id, action, after) {
  // Notify every other connected family member and the patient. Never names of drugs.
  const family = (
    await db.query(
      `SELECT CASE WHEN requester_id=$1 THEN addressee_id ELSE requester_id END id
  FROM user_connections WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$1) UNION SELECT $1::integer`,
      [patient]
    )
  ).rows;
  for (const { id: recipient } of family)
    if (
      Number(recipient) !== Number(actor) &&
      !(Number(recipient) === patient && after?.consent_state === 'PENDING')
    )
      await c.message(db, {
        key: `med.schedule:${id}:${action}:${after?.revision ?? 0}:${recipient}`,
        subject: patient,
        recipient,
        kind: 'med_schedule_changed',
        payload: { scheduleId: id, action },
      });
}
async function saveSchedule(pool, actor, patient, id, body, { notify = true } = {}) {
  patient = await c.patientAccess(pool, actor, patient);
  await c.assertFeature(pool, patient, 'medication');
  requireEncryption();
  const x = scheduleSchema.parse(body);
  if (id) c.uuid.parse(id);
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['med.schedule:' + patient]);
    // Recheck membership after taking the lock, including any concurrent revoke.
    await c.patientAccess(db, actor, patient);
    const old = id
      ? (
          await db.query(
            'SELECT * FROM med_schedules WHERE id=$1 AND patient_user_id=$2 FOR UPDATE',
            [id, patient]
          )
        ).rows[0]
      : null;
    if (id && !old) throw c.error('MED_SCHEDULE_NOT_FOUND', 404);
    if (
      Number(actor) !== patient &&
      (!old || old.consent_state !== 'ACTIVE') &&
      (
        await db.query(
          "SELECT 1 FROM med_schedules WHERE patient_user_id=$1 AND declined_at>NOW()-INTERVAL '7 days'",
          [patient]
        )
      ).rowCount
    )
      throw c.error('MED_CONSENT_COOLDOWN', 409);
    if (
      x.active &&
      (!old || !old.active || old.consent_state === 'DECLINED') &&
      (
        await db.query(
          "SELECT count(*)::int n FROM med_schedules WHERE patient_user_id=$1 AND active AND consent_state<>'DECLINED' AND id<>$2",
          [patient, id || c.randomUUID()]
        )
      ).rows[0].n >= 4
    )
      throw c.error('MED_SCHEDULE_LIMIT', 409);
    const selected = (
      await db.query(
        'SELECT * FROM med_items WHERE id=ANY($1::uuid[]) AND patient_user_id=$2 AND active',
        [x.item_ids, patient]
      )
    ).rows;
    if (selected.length !== x.item_ids.length) throw c.error('MED_ITEM_NOT_FOUND', 404);
    const consent =
      Number(actor) === patient
        ? 'ACTIVE'
        : old?.consent_state === 'ACTIVE' && old.active
          ? 'ACTIVE'
          : 'PENDING';
    const scheduleId = id || c.randomUUID();
    const result = (
      await db.query(
        `INSERT INTO med_schedules(id,patient_user_id,time_local,meal_anchor,note,created_by,consent_state,consented_at,active)
    VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='ACTIVE' THEN NOW() ELSE NULL END,$8)
    ON CONFLICT(id) DO UPDATE SET time_local=$3,meal_anchor=$4,note=$5,active=$8,consent_state=$7,
     consented_at=CASE WHEN $7='ACTIVE' THEN COALESCE(med_schedules.consented_at,NOW()) ELSE NULL END,revision=med_schedules.revision+1,updated_at=NOW() RETURNING *`,
        [
          scheduleId,
          patient,
          x.time_local,
          x.meal_anchor || null,
          protect(patient, 'med_schedules.note', x.note || ''),
          actor,
          consent,
          x.active,
        ]
      )
    ).rows[0];
    await db.query('DELETE FROM med_schedule_items WHERE schedule_id=$1', [scheduleId]);
    for (const item of selected)
      await db.query('INSERT INTO med_schedule_items(schedule_id,item_id) VALUES($1,$2)', [
        scheduleId,
        item.id,
      ]);
    // Only untouched future doses may change. Past/answered attempts retain snapshots.
    await db.query(
      "DELETE FROM med_dose_events WHERE schedule_id=$1 AND state='SCHEDULED' AND attempt_count=0 AND scheduled_at>NOW()",
      [scheduleId]
    );
    if (!x.active) await cancelScheduleCalls(db, scheduleId);
    if (
      consent === 'PENDING' &&
      x.active &&
      (!old || old.consent_state !== 'PENDING' || !old.active)
    ) {
      await db.query('UPDATE med_schedules SET consent_reminded_at=NULL WHERE id=$1', [scheduleId]);
      await db.query(
        `INSERT INTO med_consent_calls(id,schedule_id,patient_user_id) VALUES($1,$2,$3) ON CONFLICT(schedule_id) DO UPDATE SET id=EXCLUDED.id,state='QUEUED',next_at=NOW(),deadline=NULL,channel='push'`,
        [c.randomUUID(), scheduleId, patient]
      );
      if (notify)
        await c.message(db, {
          key: 'med.consent:' + scheduleId + ':' + result.revision,
          subject: patient,
          recipient: patient,
          kind: 'med_consent',
          payload: { scheduleId, time: x.time_local },
        });
    }
    await scheduleAudit(
      db,
      patient,
      actor,
      scheduleId,
      old ? 'updated' : 'created',
      old,
      {
        ...result,
        note: x.note,
      },
      notify
    );
    return { schedule: { ...publicSchedule(result), item_ids: x.item_ids } };
  });
}
async function cancelScheduleCalls(db, id) {
  await db.query(
    "UPDATE med_dose_events SET state='CANCELLED',updated_at=NOW() WHERE schedule_id=$1 AND state IN('SCHEDULED','CALLING')",
    [id]
  );
  await db.query(
    `UPDATE med_call_attempts a SET state='ENDED',ended_at=NOW(),end_reason='schedule_cancelled' FROM med_dose_events e
  WHERE a.dose_event_id=e.id AND e.schedule_id=$1 AND a.state IN('QUEUED','SENDING','DELIVERED')`,
    [id]
  );
  await db.query("UPDATE med_consent_calls SET state='ENDED' WHERE schedule_id=$1", [id]);
}
async function remove(pool, actor, patient, id) {
  patient = await c.patientAccess(pool, actor, patient);
  c.uuid.parse(id);
  await c.assertFeature(pool, patient, 'medication');
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    await c.patientAccess(db, actor, patient);
    const row = (
      await db.query(
        'UPDATE med_schedules SET active=FALSE,revision=revision+1,updated_at=NOW() WHERE id=$1 AND patient_user_id=$2 RETURNING *',
        [id, patient]
      )
    ).rows[0];
    if (!row) throw c.error('MED_SCHEDULE_NOT_FOUND', 404);
    await cancelScheduleCalls(db, id);
    await scheduleAudit(db, patient, actor, id, 'deleted', null, { revision: row.revision });
    return { deleted: true };
  });
}
async function consent(pool, patient, id, accept, { notify = true } = {}) {
  c.uuid.parse(id);
  c.z.boolean().parse(accept);
  await c.assertFeature(pool, patient, 'medication');
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    const row = (
      await db.query(
        'SELECT * FROM med_schedules WHERE id=$1 AND patient_user_id=$2 AND active FOR UPDATE',
        [id, patient]
      )
    ).rows[0];
    if (!row) throw c.error('MED_SCHEDULE_NOT_FOUND', 404);
    if (row.consent_state !== 'PENDING') return { schedule: publicSchedule(row) };
    const saved = (
      await db.query(
        `UPDATE med_schedules SET consent_state=$2,consented_at=CASE WHEN $3 THEN NOW() ELSE NULL END,
   declined_at=CASE WHEN $3 THEN NULL ELSE NOW() END,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id, accept ? 'ACTIVE' : 'DECLINED', accept]
      )
    ).rows[0];
    await db.query("UPDATE med_consent_calls SET state='ENDED' WHERE schedule_id=$1", [id]);
    await scheduleAudit(
      db,
      patient,
      patient,
      id,
      accept ? 'accepted' : 'declined',
      row,
      saved,
      notify
    );
    return { schedule: publicSchedule(saved) };
  });
}
async function saveMeals(pool, actor, patient, body) {
  patient = await c.patientAccess(pool, actor, patient);
  await c.assertFeature(pool, patient, 'medication');
  const x = mealSchema.parse(body);
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    await c.patientAccess(db, actor, patient);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['med.schedule:' + patient]);
    await db.query(
      `INSERT INTO user_meal_times(user_id,breakfast,lunch,dinner,bedtime) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(user_id) DO UPDATE SET breakfast=$2,lunch=$3,dinner=$4,bedtime=$5,updated_at=NOW()`,
      [patient, x.breakfast, x.lunch, x.dinner, x.bedtime]
    );
    // New schedules derive their time from these anchors. Existing schedules keep
    // their confirmed exact minute until explicitly edited on the review screen.
    return { meals: x };
  });
}
async function doses(db, actor, patient) {
  patient = await c.patientAccess(db, actor, patient);
  await c.assertFeature(db, patient, 'medication');
  const items = (
    await db.query(
      `SELECT e.*,s.time_local FROM med_dose_events e JOIN med_schedules s ON s.id=e.schedule_id
 WHERE e.patient_user_id=$1 AND e.local_date=(NOW() AT TIME ZONE e.timezone)::date ORDER BY e.scheduled_at`,
      [patient]
    )
  ).rows;
  return { items: items.map((e) => ({ ...e, time_local: String(e.time_local).slice(0, 5) })) };
}
async function setup(pool, actor, patient, body) {
  patient = await c.patientAccess(pool, actor, patient);
  await c.assertFeature(pool, patient, 'medication');
  requireEncryption();
  const x = c.z
    .object({
      request_id: c.uuid,
      items: c.z.array(itemSchema).min(1).max(20),
      meals: mealSchema,
      slots: c.z
        .array(
          c.z
            .object({
              time_local: p.time,
              meal_anchor: c.z.enum(p.anchors).nullable().optional(),
              item_indexes: c.z.array(c.z.number().int().nonnegative()).min(1).max(20),
            })
            .strict()
        )
        .min(1)
        .max(4),
    })
    .strict()
    .parse(body);
  if (
    new Set(x.slots.map((s) => s.time_local)).size !== x.slots.length ||
    x.slots.some((s) => s.item_indexes.some((i) => i >= x.items.length))
  )
    throw c.error('MED_SETUP_INVALID');
  const fingerprint = require('node:crypto')
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(JSON.stringify({ patient, ...x }))
    .digest('hex');
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['med.setup:' + actor]);
    await c.patientAccess(db, actor, patient);
    const old = (
      await db.query('SELECT * FROM med_setup_receipts WHERE actor_id=$1 AND request_id=$2', [
        actor,
        x.request_id,
      ])
    ).rows[0];
    if (old) {
      if (old.fingerprint !== fingerprint) throw c.error('MED_REQUEST_CHANGED', 409);
      return JSON.parse(reveal(patient, 'med_setup_receipts.result_json', old.result_json));
    }
    await saveMeals(db, actor, patient, x.meals);
    const items = [];
    for (const row of x.items) items.push((await createItem(db, actor, patient, row)).item);
    const schedules = [];
    for (const slot of x.slots)
      schedules.push(
        (
          await saveSchedule(
            db,
            actor,
            patient,
            null,
            {
              time_local: slot.time_local,
              meal_anchor: slot.meal_anchor,
              item_ids: slot.item_indexes.map((i) => items[i].id),
            },
            { notify: false }
          )
        ).schedule
      );
    const result = { schedules, items, pendingConsent: Number(actor) !== patient };
    if (result.pendingConsent)
      await c.message(db, {
        key: 'med.setup.consent:' + x.request_id,
        subject: patient,
        recipient: patient,
        kind: 'med_consent',
        payload: { scheduleId: schedules[0].id },
      });
    await notifySchedule(db, patient, actor, schedules[0].id, 'created', schedules[0]);
    await db.query(
      'INSERT INTO med_setup_receipts(actor_id,request_id,patient_user_id,fingerprint,result_json) VALUES($1,$2,$3,$4,$5)',
      [
        actor,
        x.request_id,
        patient,
        fingerprint,
        protect(patient, 'med_setup_receipts.result_json', JSON.stringify(result)),
      ]
    );
    return result;
  });
}
async function consentMany(pool, patient, body) {
  const x = c.z
    .object({
      schedule_ids: c.z
        .array(c.uuid)
        .min(1)
        .max(4)
        .refine((a) => new Set(a).size === a.length),
      accept: c.z.boolean(),
    })
    .strict()
    .parse(body);
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    const schedules = [];
    for (const id of [...x.schedule_ids].sort())
      schedules.push((await consent(db, patient, id, x.accept, { notify: false })).schedule);
    await notifySchedule(
      db,
      Number(patient),
      patient,
      schedules[0].id,
      x.accept ? 'accepted' : 'declined',
      schedules[0]
    );
    return { schedules };
  });
}
async function weekly(db, actor, target) {
  const patient = await c.patientAccess(db, actor, target);
  await c.assertFeature(db, patient, 'medication');
  const report = (
    await db.query(
      `SELECT
 (SELECT count(*) FROM med_dose_events WHERE patient_user_id=$1 AND has_medicine AND state<>'CANCELLED' AND local_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int total,
 (SELECT count(*) FROM med_dose_events WHERE patient_user_id=$1 AND has_medicine AND state='TAKEN' AND local_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int taken,
 (SELECT count(*) FROM med_dose_events WHERE patient_user_id=$1 AND has_medicine AND state='SKIPPED' AND local_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int skipped,
 (SELECT COALESCE(sum(delta),0) FROM coin_ledger WHERE user_id=$1 AND delta>0 AND reason<>'REFUND' AND local_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int coins`,
      [patient]
    )
  ).rows[0];
  return { report };
}
async function preferences(pool, actor, target, body) {
  const patient = await c.patientAccess(pool, actor, target);
  await c.assertFeature(pool, patient, 'medication');
  const x = c.z.object({ problems_only: c.z.boolean() }).strict().parse(body);
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    await c.patientAccess(db, actor, patient);
    await db.query(
      'INSERT INTO med_family_preferences(caregiver_id,patient_user_id,problems_only) VALUES($1,$2,$3) ON CONFLICT(caregiver_id,patient_user_id) DO UPDATE SET problems_only=$3',
      [actor, patient, x.problems_only]
    );
    return x;
  });
}
module.exports = {
  consentMany,
  weekly,
  preferences,
  overview,
  patients,
  createItem,
  saveSchedule,
  remove,
  consent,
  saveMeals,
  doses,
  publicItem,
  publicSchedule,
  requireEncryption,
  protect,
  reveal,
  noDose,
  nameSchema,
  itemSchema,
  scheduleSchema,
  mealSchema,
  cancelScheduleCalls,
  setup,
};
