'use strict';
const jwt = require('jsonwebtoken');
const c = require('../v21/common');
const { hasAiConsent } = require('../ai/ai-consent.service');
const { cacheDel } = require('../../lib/redis');
const audience = 'asinu:assistant-profile';
const error = code => c.error(code, 409);
function conditions(values) {
  return [...new Set(values.map(value => typeof value === 'string' ? value : value?.other_text || value?.label || value?.key)
    .filter(value => typeof value === 'string' && !['', 'none', 'no', 'không', 'không có'].includes(value.trim().toLowerCase())))];
}
async function read(db, userId) {
  const row = (await db.query(`SELECT COALESCE(u.full_name,u.display_name,'') name,u.xmin::text user_version,
    p.xmin::text profile_version,p.date_of_birth::text date_of_birth,p.gender,p.height_cm,p.blood_type,p.medical_conditions,p.chronic_symptoms
    FROM users u LEFT JOIN user_onboarding_profiles p ON p.user_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL`, [userId])).rows[0];
  if (!row) throw error('APP_ASSISTANT_PROFILE_CONFLICT');
  return { name: row.name, dateOfBirth: row.date_of_birth, gender: row.gender, heightCm: row.height_cm == null ? undefined : Number(row.height_cm), bloodType: row.blood_type,
    chronicDiseases: conditions([...(row.medical_conditions || []), ...(row.chronic_symptoms || [])]),
    version: `${row.user_version}:${row.profile_version || 'none'}` };
}
const publicContext = value => value ? { name: value.name, dateOfBirth: value.dateOfBirth, gender: value.gender, heightCm: value.heightCm, bloodType: value.bloodType, chronicDiseases: value.chronicDiseases } : null;
function prepare(action, context, userId) {
  if (!context?.version || !process.env.JWT_SECRET) throw error('APP_ASSISTANT_PROFILE_CONFLICT');
  return { ...action, planToken: jwt.sign({ kind: 'profile', version: context.version, changes: action.changes }, process.env.JWT_SECRET,
    { algorithm: 'HS256', audience, subject: String(userId), expiresIn: '10m' }) };
}
const equalChanges = (value, changes) => Object.entries(changes).every(([key, expected]) =>
  Array.isArray(expected) ? JSON.stringify([...(value[key] || [])].sort()) === JSON.stringify([...expected].sort()) : value[key] === expected);
async function execute(pool, userId, token) {
  let plan;
  try {
    plan = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], audience, subject: String(userId), ignoreExpiration: true });
    const { profileSchema } = require('./app-tools.service');
    if (plan.kind !== 'profile' || !Number.isFinite(plan.exp) || !profileSchema.safeParse({ type: 'profile', changes: plan.changes, evidence: 'confirmed' }).success) throw Error('invalid');
  } catch { throw error('APP_ASSISTANT_PLAN_EXPIRED'); }
  try {
    return await c.transaction(pool, async db => {
      await c.lockPatient(db, userId);
      await db.query('SELECT user_id FROM user_onboarding_profiles WHERE user_id=$1 FOR UPDATE', [userId]);
      await db.query('SELECT user_id FROM user_ai_consents WHERE user_id=$1 FOR SHARE', [userId]);
      if (!(await hasAiConsent(db, userId))) throw c.error('AI_CONSENT_REQUIRED', 403);
      const before = await read(db, userId);
      if (equalChanges(before, plan.changes)) {
        const result = await require('../profile/profile.service').getProfile(db, userId);
        if (!result.ok) throw error('APP_ASSISTANT_PROFILE_CONFLICT');
        return { profile: result.profile, replay: true };
      }
      if (Date.now() >= plan.exp * 1000) throw error('APP_ASSISTANT_PLAN_EXPIRED');
      if (before.version !== plan.version) throw error('APP_ASSISTANT_PROFILE_CONFLICT');
      const result = await require('../profile/profile.service').updateProfile(db, userId, plan.changes);
      if (!result.ok || !equalChanges(await read(db, userId), plan.changes)) throw error('APP_ASSISTANT_PROFILE_CONFLICT');
      return { profile: result.profile };
    });
  } catch (reason) {
    await cacheDel(`profile:${userId}`, `user:name:${userId}`).catch(() => {});
    throw reason;
  }
}
module.exports = { read, publicContext, prepare, execute };
