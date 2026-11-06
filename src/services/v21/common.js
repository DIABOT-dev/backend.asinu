'use strict';
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const idSchema = z.coerce.number().int().positive().safe();
const uuid = z.string().uuid();
const error = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
async function transaction(pool, work) {
  const nested = typeof pool.release === 'function',
    db = nested ? pool : await pool.connect();
  const savepoint = 'v21_' + randomUUID().replaceAll('-', '');
  try {
    await db.query(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN');
    const result = await work(db);
    await db.query(nested ? 'RELEASE SAVEPOINT ' + savepoint : 'COMMIT');
    return result;
  } catch (e) {
    await db.query(nested ? 'ROLLBACK TO SAVEPOINT ' + savepoint : 'ROLLBACK');
    throw e;
  } finally {
    if (!nested) db.release();
  }
}
// All medication mutations lock the patient first. NO KEY UPDATE serializes
// reminder work without blocking the foreign-key checks of family outboxes.
async function lockPatient(db, user, { optional = false } = {}) {
  const row = (
    await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE', [
      user,
    ])
  ).rows[0];
  if (!row && !optional) throw error('MED_PATIENT_NOT_FOUND', 404);
  return row;
}
async function config(db, user) {
  try {
    const c = (await db.query('SELECT *,NOW() AS server_time FROM v21_config WHERE id=1')).rows[0];
    const allowed =
      !!c && (!c.rollout_user_ids.length || c.rollout_user_ids.map(Number).includes(Number(user)));
    return {
      medication: allowed && c.medication_enabled,
      coins: allowed && c.coins_enabled,
      scan: allowed && c.medication_enabled && c.scan_enabled,
      nativeCall:
        allowed &&
        c.medication_enabled &&
        c.native_call_enabled &&
        process.env.MED_CALL_ENABLED === 'true',
    };
  } catch (e) {
    if (e.code === '42P01')
      return { medication: false, coins: false, scan: false, nativeCall: false };
    throw e;
  }
}
async function assertFeature(db, user, feature) {
  if (!(await config(db, user))[feature]) throw error('V21_FEATURE_DISABLED', 404);
}
async function patientAccess(db, actor, patient, { selfOnly = false } = {}) {
  actor = idSchema.parse(actor);
  patient = idSchema.parse(patient || actor);
  const p = (await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL', [patient]))
    .rows[0];
  if (!p) throw error('MED_PATIENT_NOT_FOUND', 404);
  if (actor !== patient) {
    if (selfOnly) throw error('V21_PATIENT_ONLY', 403);
    if (
      !(
        await db.query(
          `SELECT 1 FROM user_connections WHERE status='accepted'
   AND ((requester_id=$1 AND addressee_id=$2) OR(requester_id=$2 AND addressee_id=$1)) ${typeof db.release === 'function' ? 'FOR SHARE' : ''}`,
          [actor, patient]
        )
      ).rowCount
    )
      throw error('MED_CARE_CIRCLE_REQUIRED', 403);
  }
  return patient;
}
async function hasConnection(db, owner, recipient) {
  return !!(
    await db.query(
      `SELECT 1 FROM user_connections c
 JOIN users u ON u.id=$2 AND u.deleted_at IS NULL
 WHERE c.status='accepted' AND ((c.requester_id=$1 AND c.addressee_id=$2) OR(c.requester_id=$2 AND c.addressee_id=$1))`,
      [owner, recipient]
    )
  ).rowCount;
}
const localDate = (date = new Date(), timezone = 'Asia/Ho_Chi_Minh') => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(date))
      .map((p) => [p.type, p.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
};
async function balanceLock(db, user) {
  await db.query('INSERT INTO coin_balances(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user]);
  return (await db.query('SELECT * FROM coin_balances WHERE user_id=$1 FOR UPDATE', [user]))
    .rows[0];
}
async function message(db, { key, subject, recipient, kind, payload = {} }) {
  return db.query(
    `INSERT INTO v21_message_outbox(event_key,subject_id,recipient_id,kind,payload)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [key, subject, recipient, kind, JSON.stringify(payload)]
  );
}
function captureUnexpected(error, route) {
  if (error instanceof z.ZodError || error.statusCode || error.code === '23505') return;
  require('../../lib/sentry').captureException(
    Object.assign(new Error('V21_UNAVAILABLE'), {
      code: /^[A-Z0-9_]{3,40}$/.test(error.code || '') ? error.code : 'V21_UNAVAILABLE',
    }),
    { component: 'v21', operation: 'http', route }
  );
}
module.exports = {
  lockPatient,
  captureUnexpected,
  z,
  idSchema,
  uuid,
  error,
  transaction,
  config,
  assertFeature,
  patientAccess,
  hasConnection,
  localDate,
  balanceLock,
  message,
  randomUUID,
};
