const { onboardingRequestSchema } = require('../validation/schemas');

const normalizeText = (value) => String(value || '').trim();

const issueLabel = (item) => {
  if (typeof item === 'string') return normalizeText(item);
  if (!item || typeof item !== 'object') return '';
  return normalizeText(item.other_text || item.label || item.key || '');
};

const normalizeStringList = (items) => {
  if (!Array.isArray(items)) return [];
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const label = issueLabel(item);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(label);
  }
  return result;
};

const normalizeJointIssues = (items) => {
  if (!Array.isArray(items)) return [];
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const key = normalizeText(item.key);
    const label = normalizeText(item.label);
    const otherText = item.other_text ? normalizeText(item.other_text) : null;
    if (!key || !label) continue;
    const dedupeKey = `${key.toLowerCase()}|${label.toLowerCase()}|${(otherText || '').toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(otherText ? { key, label, other_text: otherText } : { key, label });
  }
  return result;
};

async function upsertOnboardingProfile(pool, req, res) {
  const parsed = onboardingRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
  }

  const { user_id: payloadUserId, profile } = parsed.data;
  const userId = Number(req.user?.id);
  if (!Number.isFinite(userId)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (payloadUserId !== undefined && payloadUserId !== userId) {
    return res.status(403).json({ ok: false, error: 'user_id_mismatch' });
  }

  const {
    age,
    gender,
    goal,
    body_type,
    medical_conditions,
    chronic_symptoms,
    joint_issues,
    flexibility,
    stairs_performance,
    exercise_freq,
    walking_habit,
    water_intake,
    sleep_duration,
  } = profile;

  const normalizedMedical = normalizeStringList(medical_conditions);
  const normalizedSymptoms = normalizeStringList(chronic_symptoms);
  const normalizedJoints = normalizeJointIssues(joint_issues);

  try {
    const result = await pool.query(
      `INSERT INTO user_onboarding_profiles (
        user_id,
        age,
        gender,
        goal,
        body_type,
        medical_conditions,
        chronic_symptoms,
        joint_issues,
        flexibility,
        stairs_performance,
        exercise_freq,
        walking_habit,
        water_intake,
        sleep_duration,
        created_at,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,NOW(),NOW()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        age = EXCLUDED.age,
        gender = EXCLUDED.gender,
        goal = EXCLUDED.goal,
        body_type = EXCLUDED.body_type,
        medical_conditions = EXCLUDED.medical_conditions,
        chronic_symptoms = EXCLUDED.chronic_symptoms,
        joint_issues = EXCLUDED.joint_issues,
        flexibility = EXCLUDED.flexibility,
        stairs_performance = EXCLUDED.stairs_performance,
        exercise_freq = EXCLUDED.exercise_freq,
        walking_habit = EXCLUDED.walking_habit,
        water_intake = EXCLUDED.water_intake,
        sleep_duration = EXCLUDED.sleep_duration,
        updated_at = NOW()
      RETURNING user_id, age, gender, goal, body_type, medical_conditions, chronic_symptoms,
                joint_issues, flexibility, stairs_performance, exercise_freq, walking_habit,
                water_intake, sleep_duration, created_at, updated_at`,
      [
        userId,
        age,
        gender,
        goal,
        body_type,
        JSON.stringify(normalizedMedical),
        JSON.stringify(normalizedSymptoms),
        JSON.stringify(normalizedJoints),
        flexibility,
        stairs_performance,
        exercise_freq,
        walking_habit,
        water_intake,
        sleep_duration,
      ]
    );

    const row = result.rows[0];
    return res.status(200).json({ ok: true, profile: row });
  } catch (err) {
    console.error('onboarding upsert failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = { upsertOnboardingProfile };
