'use strict';

const { z } = require('zod');

const STEP_IDS = [
  'home.fine', 'home.unwell', 'checkin.status', 'checkin.location', 'checkin.location_other',
  'checkin.choices', 'checkin.other', 'checkin.practice', 'checkin.voice', 'checkin.location_confirm',
  'checkin.multiple', 'checkin.single', 'checkin.confirm', 'checkin.result_status', 'checkin.result_symptoms',
  'checkin.result_advice', 'checkin.result_replay', 'checkin.result_doctor', 'checkin.result_emergency',
  'checkin.result_family', 'checkin.result_variants', 'checkin.result_close', 'checkin.finished', 'home.suggestions',
  'circle.add', 'circle.phone', 'circle.relationship', 'circle.send', 'circle.member',
];
const patchSchema = z.object({
  epoch: z.number().int().nonnegative(),
  role: z.enum(['self', 'caregiver']).optional(),
  welcomeSeen: z.literal(true).optional(),
  readAloud: z.boolean().optional(),
  firstCheckin: z.literal(true).optional(),
  completed: z.array(z.enum(STEP_IDS)).max(STEP_IDS.length).optional(),
}).strict();

function toProgress(row) {
  return {
    role: row.role || null,
    welcomeSeen: row.welcome_seen,
    readAloud: row.read_aloud,
    firstCheckin: row.first_checkin,
    completed: STEP_IDS.filter(id => Object.hasOwn(row.completed || {}, id)),
    epoch: row.epoch,
  };
}

async function getProgress(pool, userId) {
  const result = await pool.query(
    `INSERT INTO user_guidance_progress (user_id, first_checkin)
     VALUES ($1, EXISTS(SELECT 1 FROM health_checkins WHERE user_id = $1
       AND (initial_status = 'fine' OR triage_completed_at IS NOT NULL OR resolved_at IS NOT NULL)))
     ON CONFLICT (user_id) DO UPDATE SET first_checkin =
       user_guidance_progress.first_checkin OR EXCLUDED.first_checkin RETURNING *`,
    [userId]
  );
  return toProgress(result.rows[0]);
}

async function updateProgress(pool, userId, body) {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return { ok: false, statusCode: 400, code: 'GUIDANCE_INVALID' };
  const data = parsed.data;
  const completed = Object.fromEntries((data.completed || []).map(id => [id, true]));
  // Acknowledgements are monotonic and merged atomically across devices.
  const result = await pool.query(
    `UPDATE user_guidance_progress SET
       role = COALESCE($2, role), welcome_seen = welcome_seen OR $3,
       read_aloud = COALESCE($4, read_aloud), first_checkin = first_checkin OR $5,
       completed = completed || $6::jsonb, updated_at = now()
     WHERE user_id = $1 AND epoch = $7 RETURNING *`,
    [userId, data.role || null, data.welcomeSeen === true, data.readAloud ?? null,
      data.firstCheckin === true, JSON.stringify(completed), data.epoch]
  );
  if (!result.rows[0]) return { ok: false, statusCode: 409, code: 'GUIDANCE_STALE' };
  return { ok: true, progress: toProgress(result.rows[0]) };
}

async function replayProgress(pool, userId) {
  // Read-aloud preference, chosen role and real check-in history are retained.
  await getProgress(pool, userId);
  const result = await pool.query(
    `UPDATE user_guidance_progress SET completed = '{}'::jsonb,
       welcome_seen = FALSE, epoch = epoch + 1, updated_at = now()
     WHERE user_id = $1 RETURNING *`, [userId]
  );
  return toProgress(result.rows[0]);
}

module.exports = { STEP_IDS, patchSchema, getProgress, updateProgress, replayProgress };
