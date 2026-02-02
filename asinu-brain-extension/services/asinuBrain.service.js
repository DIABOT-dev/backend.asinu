const crypto = require('crypto');
const { calculateRisk } = require('../risk/AsinuRiskEngine');
const { computePsV1, DEFAULT_CONFIG } = require('../risk/AsinuRiskEngineB');
const { sendPushNotification } = require('../../src/services/push.notification.service');

const ENGINE_B_VERSION = 'B-PS-V1';
const SHADOW_ENV_KEYS = ['ASINU_SHADOW_MODE', 'SHADOW_MODE'];

const MOOD_OPTIONS = [
  { value: 'OK', label: 'OK' },
  { value: 'TIRED', label: 'Tired' },
  { value: 'NOT_OK', label: 'Not OK' }
];

const SYMPTOM_OPTIONS = [
  { value: 'none', label: 'No symptoms' },
  { value: 'chest_pain', label: 'Chest pain' },
  { value: 'shortness_of_breath', label: 'Shortness of breath' },
  { value: 'dizziness', label: 'Dizziness' },
  { value: 'fever', label: 'Fever' },
  { value: 'headache', label: 'Headache' },
  { value: 'nausea', label: 'Nausea' },
  { value: 'other', label: 'Other' }
];

const SEVERITY_OPTIONS = [
  { value: 'mild', label: 'Mild' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'severe', label: 'Severe' }
];

const buildMoodQuestion = (text, phase) => ({
  id: 'mood',
  type: 'single_choice',
  text,
  options: MOOD_OPTIONS,
  phase_in_day: phase || null
});

const QUESTIONS = {
  mood_morning: buildMoodQuestion('Hom nay bac thay on khong?', 'MORNING'),
  mood_followup: (phase) => buildMoodQuestion('Bac thay on hon chua?', phase || 'NOON'),
  symptom_severity: {
    id: 'symptom_severity',
    type: 'symptom_severity',
    text: 'Bac co trieu chung nao va muc do?',
    symptoms: SYMPTOM_OPTIONS,
    severity_options: SEVERITY_OPTIONS
  }
};

const HIGH_RISK_KEYWORDS = [
  'diabetes',
  'hypertension',
  'high blood',
  'heart',
  'cardio',
  'stroke',
  'kidney',
  'cancer',
  'lung',
  'asthma',
  'tim mach',
  'tieu duong',
  'huyet ap'
];

const normalizeText = (value) => String(value || '').toLowerCase().trim();

const extractConditions = (profile) => {
  const list = [];
  if (!profile) return list;
  const medical = Array.isArray(profile.medical_conditions) ? profile.medical_conditions : [];
  const chronic = Array.isArray(profile.chronic_symptoms) ? profile.chronic_symptoms : [];
  for (const item of [...medical, ...chronic]) {
    if (typeof item === 'string') list.push(item);
    if (item && typeof item === 'object') {
      if (item.label) list.push(item.label);
      if (item.key) list.push(item.key);
      if (item.other_text) list.push(item.other_text);
    }
  }
  return list;
};

const countHighRiskConditions = (profile) => {
  const conditions = extractConditions(profile).map(normalizeText).filter(Boolean);
  const matched = new Set();
  for (const condition of conditions) {
    for (const keyword of HIGH_RISK_KEYWORDS) {
      if (condition.includes(keyword)) {
        matched.add(keyword);
      }
    }
  }
  return matched.size;
};

const parseAge = (ageValue) => {
  if (ageValue === null || ageValue === undefined) return null;
  if (typeof ageValue === 'number') return ageValue;
  const text = String(ageValue).trim();
  const match = text.match(/\d+/);
  if (!match) return null;
  return Number(match[0]);
};

const deriveAgeBand = (ageValue) => {
  const age = parseAge(ageValue);
  if (age === null) return 'U60';
  if (age >= 80) return '80P';
  if (age >= 70) return '70_79';
  if (age >= 60) return '60_69';
  return 'U60';
};

const deriveComorbidityTier = (profile) => {
  const count = countHighRiskConditions(profile);
  return Math.min(3, Math.max(0, count));
};

const deriveFrailtyTier = (profile) => {
  if (!profile) return 0;
  let score = 0;
  const jointIssues = Array.isArray(profile.joint_issues)
    ? profile.joint_issues.length > 0
    : Boolean(profile.joint_issues);
  if (jointIssues) score += 1;

  const flexibility = normalizeText(profile.flexibility);
  const stairs = normalizeText(profile.stairs_performance);
  const exercise = normalizeText(profile.exercise_freq);

  if (flexibility.includes('low') || flexibility.includes('limited')) score += 1;
  if (stairs.includes('poor') || stairs.includes('hard') || stairs.includes('difficult')) score += 1;
  if (exercise.includes('never') || exercise.includes('rare')) score += 1;

  if (score >= 3) return 2;
  if (score >= 1) return 1;
  return 0;
};

const isProfileVerified = (profile) => {
  if (!profile) return false;
  const fields = ['age', 'gender', 'goal', 'body_type', 'medical_conditions', 'chronic_symptoms'];
  let count = 0;
  for (const field of fields) {
    const value = profile[field];
    if (value !== null && value !== undefined && String(value).length > 0) count += 1;
  }
  return count >= 3;
};

const mapSeverityScore = (value) => {
  if (value === 'severe') return 3;
  if (value === 'moderate') return 2;
  return 1;
};

const parseMoodValue = (payload) => {
  if (!payload) return null;
  return payload.option_id || payload.value || null;
};

const toBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().trim();
    return ['true', '1', 'yes', 'on'].includes(normalized);
  }
  return false;
};

const readShadowMode = (params) => {
  if (params && Object.prototype.hasOwnProperty.call(params, 'shadow_mode')) {
    return toBoolean(params.shadow_mode);
  }
  for (const key of SHADOW_ENV_KEYS) {
    const raw = process.env[key];
    if (raw !== undefined) return toBoolean(raw);
  }
  return false;
};

const loadActiveConfig = async (pool) => {
  let configVersion = 'default';
  let params = { ...DEFAULT_CONFIG };

  const versionResult = await pool.query(
    `SELECT config_version
     FROM risk_config_versions
     WHERE is_active = true
     ORDER BY created_at DESC
     LIMIT 1`
  );

  if (versionResult.rows[0]) {
    configVersion = versionResult.rows[0].config_version;
    const paramsResult = await pool.query(
      `SELECT key, value
       FROM risk_config_params
       WHERE config_version = $1`,
      [configVersion]
    );

    params = {};
    for (const row of paramsResult.rows) {
      params[row.key] = row.value;
    }
  }

  const shadowMode = readShadowMode(params);

  return { configVersion, params, shadowMode };
};

const getRiskPersistence = async (pool, userId) => {
  const result = await pool.query(
    `SELECT *
     FROM risk_persistence
     WHERE user_id = $1
     ORDER BY last_updated_at DESC NULLS LAST
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
};

const upsertRiskPersistence = async (pool, userId, payload) => {
  const result = await pool.query(
    `INSERT INTO risk_persistence (user_id, risk_score, risk_tier, last_updated_at, streak_ok_days)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       risk_score = EXCLUDED.risk_score,
       risk_tier = EXCLUDED.risk_tier,
       last_updated_at = EXCLUDED.last_updated_at,
       streak_ok_days = EXCLUDED.streak_ok_days,
       updated_at = NOW()
     RETURNING *`,
    [
      userId,
      payload.risk_score,
      payload.risk_tier,
      payload.last_updated_at,
      payload.streak_ok_days
    ]
  );
  return result.rows[0];
};

const getSnapshotForSession = async (pool, sessionId) => {
  const result = await pool.query(
    `SELECT snapshot_json
     FROM asinu_brain_context_snapshots
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return result.rows[0]?.snapshot_json || null;
};

const createSnapshot = async (pool, sessionId, userId, snapshot) => {
  await pool.query(
    `INSERT INTO asinu_brain_context_snapshots (session_id, user_id, snapshot_json)
     VALUES ($1, $2, $3)` ,
    [sessionId, userId, snapshot || {}]
  );
};

const fetchOnboardingProfile = async (pool, userId) => {
  const result = await pool.query(
    `SELECT age, gender, goal, body_type, medical_conditions, chronic_symptoms,
            joint_issues, flexibility, stairs_performance, exercise_freq,
            walking_habit, water_intake, sleep_duration
     FROM user_onboarding_profiles
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
};

const fetchLogsSummary = async (pool, userId) => {
  const countsResult = await pool.query(
    `SELECT log_type, COUNT(*)::int AS count
     FROM logs_common
     WHERE user_id = $1 AND occurred_at >= NOW() - INTERVAL '7 days'
     GROUP BY log_type`,
    [userId]
  );

  const latestGlucose = await pool.query(
    `SELECT d.value, d.unit, c.occurred_at
     FROM logs_common c
     JOIN glucose_logs d ON d.log_id = c.id
     WHERE c.user_id = $1 AND c.log_type = 'glucose'
       AND c.occurred_at >= NOW() - INTERVAL '7 days'
     ORDER BY c.occurred_at DESC
     LIMIT 1`,
    [userId]
  );

  const latestBp = await pool.query(
    `SELECT d.systolic, d.diastolic, d.pulse, c.occurred_at
     FROM logs_common c
     JOIN blood_pressure_logs d ON d.log_id = c.id
     WHERE c.user_id = $1 AND c.log_type = 'bp'
       AND c.occurred_at >= NOW() - INTERVAL '7 days'
     ORDER BY c.occurred_at DESC
     LIMIT 1`,
    [userId]
  );

  return {
    counts: countsResult.rows,
    latest_glucose: latestGlucose.rows[0] || null,
    latest_bp: latestBp.rows[0] || null
  };
};

const ensureSnapshot = async (pool, sessionId, userId) => {
  const existing = await getSnapshotForSession(pool, sessionId);
  if (existing) return existing;

  const [profile, logsSummary, persistence] = await Promise.all([
    fetchOnboardingProfile(pool, userId),
    fetchLogsSummary(pool, userId),
    getRiskPersistence(pool, userId)
  ]);

  const snapshot = {
    onboarding: profile,
    logs_summary: logsSummary,
    risk_persistence: persistence
  };

  await createSnapshot(pool, sessionId, userId, snapshot);
  return snapshot;
};

const ensureSession = async (pool, userId, sessionId, tracker) => {
  let session = await getSessionById(pool, userId, sessionId);
  if (!session && tracker?.locked_session_id) {
    session = await getSessionById(pool, userId, tracker.locked_session_id);
  }
  if (!session) {
    session = await getActiveSession(pool, userId);
  }
  if (!session || session.status !== 'open') {
    session = await createSession(pool, userId);
  }
  return session;
};

const scheduleAt = (now, hours, minutes) => {
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
};

const computeNextDue = (path, phase, now) => {
  if (path === 'GREEN') return scheduleAt(now, 20, 30);
  if (path === 'YELLOW') {
    if (phase === 'NOON') return scheduleAt(now, 12, 0);
    if (phase === 'AFTERNOON') return scheduleAt(now, 15, 30);
    if (phase === 'NIGHT') return scheduleAt(now, 20, 30);
    return scheduleAt(now, 12, 0);
  }
  if (path === 'RED') {
    return new Date(now.getTime() + 2 * 60 * 60 * 1000);
  }
  return null;
};

const advanceYellowPhase = (currentPhase) => {
  if (currentPhase === 'NOON') return 'AFTERNOON';
  if (currentPhase === 'AFTERNOON') return 'NIGHT';
  return 'NOON';
};

const derivePathFromMood = (mood) => {
  if (mood === 'OK') return 'GREEN';
  if (mood === 'TIRED') return 'YELLOW';
  if (mood === 'NOT_OK') return 'RED';
  return 'GREEN';
};

const shouldHoldPrompt = (tracker, now) => {
  if (!tracker) return false;
  if (tracker.current_path === 'EMERGENCY') return false;
  if (tracker.dismissed_until && now < tracker.dismissed_until) return true;
  if (tracker.cooldown_until && now < tracker.cooldown_until) return true;
  if (tracker.next_due_at && now < tracker.next_due_at) return true;
  return false;
};

const generateId = () => {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
};

const recordEvent = async (pool, { sessionId, userId, eventType, questionId, payload }) => {
  await pool.query(
    `INSERT INTO asinu_brain_events (session_id, user_id, event_type, question_id, payload)
     VALUES ($1, $2, $3, $4, $5)` ,
    [sessionId, userId, eventType, questionId || null, payload || {}]
  );
};

const recordOutcome = async (pool, { sessionId, userId, outcome }) => {
  const { risk_tier, notify_caregiver, outcome_text, recommended_action, metadata } = outcome;
  await pool.query(
    `INSERT INTO asinu_brain_outcomes (session_id, user_id, risk_level, notify_caregiver, recommended_action, outcome_text, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)` ,
    [
      sessionId,
      userId,
      risk_tier,
      notify_caregiver,
      recommended_action || null,
      outcome_text || null,
      metadata || {}
    ]
  );
};

const closeSession = async (pool, sessionId, lastQuestionId) => {
  await pool.query(
    `UPDATE asinu_brain_sessions
     SET status = 'closed', ended_at = NOW(), last_question_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [sessionId, lastQuestionId || null]
  );
};

const touchSession = async (pool, sessionId, lastQuestionId) => {
  await pool.query(
    `UPDATE asinu_brain_sessions
     SET last_question_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [sessionId, lastQuestionId || null]
  );
};

const markSessionAnswered = async (pool, sessionId) => {
  await pool.query(
    `UPDATE asinu_brain_sessions
     SET last_answered_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );
};

const getActiveSession = async (pool, userId) => {
  const result = await pool.query(
    `SELECT id, user_id, status, started_at, ended_at
     FROM asinu_brain_sessions
     WHERE user_id = $1 AND status = 'open'
     ORDER BY started_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
};

const getSessionById = async (pool, userId, sessionId) => {
  if (!sessionId) return null;
  const result = await pool.query(
    `SELECT id, user_id, status, started_at, ended_at
     FROM asinu_brain_sessions
     WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  return result.rows[0] || null;
};

const createSession = async (pool, userId) => {
  const id = generateId();
  await pool.query(
    `INSERT INTO asinu_brain_sessions (id, user_id, status)
     VALUES ($1, $2, 'open')`,
    [id, userId]
  );
  return { id, user_id: userId, status: 'open' };
};

const getLastEvent = async (pool, sessionId) => {
  const result = await pool.query(
    `SELECT id, event_type, question_id, payload, created_at
     FROM asinu_brain_events
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
};

const getLastAnswer = async (pool, sessionId) => {
  const result = await pool.query(
    `SELECT question_id, payload, created_at
     FROM asinu_brain_events
     WHERE session_id = $1 AND event_type = 'answer'
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
};

const getAnswerForQuestion = async (pool, sessionId, questionId) => {
  const result = await pool.query(
    `SELECT payload
     FROM asinu_brain_events
     WHERE session_id = $1 AND question_id = $2 AND event_type = 'answer'
     ORDER BY created_at ASC
     LIMIT 1`,
    [sessionId, questionId]
  );
  return result.rows[0] || null;
};

const getNotOkCount48h = async (pool, userId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM asinu_brain_events
     WHERE user_id = $1
       AND event_type = 'answer'
       AND question_id = 'mood'
       AND (
         payload->>'option_id' = 'NOT_OK'
         OR payload->>'value' = 'NOT_OK'
       )
       AND created_at >= NOW() - INTERVAL '48 hours'`,
    [userId]
  );
  return result.rows[0]?.count || 0;
};

const getActiveTracker = async (pool, userId) => {
  const result = await pool.query(
    `SELECT *
     FROM asinu_trackers
     WHERE user_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
};

const createTracker = async (pool, userId, payload) => {
  const result = await pool.query(
    `INSERT INTO asinu_trackers (
      user_id,
      current_path,
      phase_in_day,
      locked_session_id,
      next_due_at,
      cooldown_until,
      dismissed_until,
      last_prompt_at,
      status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')
    RETURNING *`,
    [
      userId,
      payload.current_path,
      payload.phase_in_day || null,
      payload.locked_session_id || null,
      payload.next_due_at || null,
      payload.cooldown_until || null,
      payload.dismissed_until || null,
      payload.last_prompt_at || null
    ]
  );
  return result.rows[0];
};

const updateTracker = async (pool, trackerId, payload) => {
  const result = await pool.query(
    `UPDATE asinu_trackers
     SET current_path = COALESCE($2, current_path),
         phase_in_day = $3,
         locked_session_id = COALESCE($4, locked_session_id),
         next_due_at = $5,
         cooldown_until = $6,
         dismissed_until = $7,
         last_prompt_at = COALESCE($8, last_prompt_at),
         status = COALESCE($9, status),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      trackerId,
      payload.current_path,
      payload.phase_in_day || null,
      payload.locked_session_id || null,
      payload.next_due_at || null,
      payload.cooldown_until || null,
      payload.dismissed_until || null,
      payload.last_prompt_at || null,
      payload.status || null
    ]
  );
  return result.rows[0] || null;
};

const getLastBrainEventAt = async (pool, userId) => {
  const result = await pool.query(
    `SELECT created_at
     FROM asinu_brain_events
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0]?.created_at || null;
};

const getMoodCounts = async (pool, userId) => {
  const result = await pool.query(
    `SELECT payload, created_at
     FROM asinu_brain_events
     WHERE user_id = $1
       AND event_type = 'answer'
       AND question_id = 'mood'
       AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC`,
    [userId]
  );

  const now = Date.now();
  let total = 0;
  let last3 = 0;
  let prev4 = 0;
  const daySet = new Set();

  for (const row of result.rows) {
    const moodValue = parseMoodValue(row.payload);
    if (moodValue !== 'TIRED' && moodValue !== 'NOT_OK') continue;
    total += 1;
    const createdAt = new Date(row.created_at);
    const daysDiff = (now - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff <= 3) last3 += 1;
    else prev4 += 1;

    const dayKey = createdAt.toISOString().slice(0, 10);
    daySet.add(dayKey);
  }

  const dayList = Array.from(daySet).sort().reverse();
  let duration = 1;
  if (dayList.length > 0) {
    duration = 1;
    for (let i = 1; i < dayList.length; i += 1) {
      const prev = new Date(dayList[i - 1]);
      const curr = new Date(dayList[i]);
      const diff = (prev - curr) / (1000 * 60 * 60 * 24);
      if (diff === 1) duration += 1;
      else break;
    }
  }

  return { total, last3, prev4, duration };
};

const buildSignal = async (pool, userId, sessionId) => {
  const [moodCounts, lastMoodAnswer, lastSymptomAnswer, notOk48h] = await Promise.all([
    getMoodCounts(pool, userId),
    getAnswerForQuestion(pool, sessionId, 'mood'),
    getAnswerForQuestion(pool, sessionId, 'symptom_severity'),
    getNotOkCount48h(pool, userId)
  ]);

  const todayMood = parseMoodValue(lastMoodAnswer?.payload);
  const severityScore = mapSeverityScore(lastSymptomAnswer?.payload?.value);
  const symptomList = Array.isArray(lastSymptomAnswer?.payload?.option_id)
    ? lastSymptomAnswer.payload.option_id
    : [];

  return {
    frequency: moodCounts.total,
    duration: moodCounts.duration,
    severity_score: severityScore,
    counts: { last3: moodCounts.last3, prev4: moodCounts.prev4 },
    today_mood: todayMood,
    has_chest_pain: symptomList.includes('chest_pain'),
    has_shortness: symptomList.includes('shortness_of_breath'),
    not_ok_48h: notOk48h
  };
};

const buildOutcomePayload = (riskResult) => {
  let outcomeText = 'Cam on bac da chia se.';
  let action = 'Tiep tuc theo doi va sinh hoat binh thuong.';

  if (riskResult.risk_tier === 'HIGH') {
    outcomeText = 'Can lien he nguoi than de kiem tra.';
    action = 'Uu tien lien he nguoi than va theo doi sat.';
  } else if (riskResult.risk_tier === 'MEDIUM') {
    outcomeText = 'Can theo doi sat hon trong hom nay.';
    action = 'Neu co thay doi, hay check-in them.';
  }

  return {
    risk_tier: riskResult.risk_tier,
    notify_caregiver: riskResult.notify_caregiver,
    outcome_text: outcomeText,
    recommended_action: action,
    metadata: {
      trend: riskResult.trend,
      explain_codes: riskResult.explain_codes
    }
  };
};

const buildEngineBInput = ({ profile, logsSummary, riskResult, signal, lastEventAt }) => {
  const trend24h = signal?.trend === 'WORSENING' ? 1 : signal?.trend === 'IMPROVING' ? -1 : 0;
  let acuteFlag = 0;
  if (signal?.has_chest_pain && signal?.has_shortness) acuteFlag = 2;
  else if (signal?.severity_score >= 3 || signal?.not_ok_48h >= 2) acuteFlag = 1;

  const logsMissing = !logsSummary || !Array.isArray(logsSummary.counts) || logsSummary.counts.length === 0;
  let missingSignal = logsMissing ? 1 : 0;
  if (lastEventAt) {
    const diff = Date.now() - new Date(lastEventAt).getTime();
    if (diff > 24 * 60 * 60 * 1000) missingSignal = 1;
  } else {
    missingSignal = 1;
  }

  return {
    risk_score: riskResult?.risk_score || 0,
    trend_24h: trend24h,
    acute_flag: acuteFlag,
    missing_signal: missingSignal,
    age_band: deriveAgeBand(profile?.age),
    comorbidity_tier: deriveComorbidityTier(profile),
    frailty_tier: deriveFrailtyTier(profile),
    profile_verified: isProfileVerified(profile)
  };
};

const writeAuditRecord = async (pool, payload) => {
  await pool.query(
    `INSERT INTO alert_decision_audit (
      user_id,
      run_at,
      engine_version,
      config_version,
      shadow_mode,
      input_snapshot,
      computation,
      output,
      explainability_payload,
      notification_sent,
      channel
    ) VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      payload.user_id,
      payload.engine_version,
      payload.config_version,
      payload.shadow_mode,
      JSON.stringify(payload.input_snapshot || {}),
      JSON.stringify(payload.computation || {}),
      JSON.stringify(payload.output || {}),
      JSON.stringify(payload.explainability_payload || {}),
      payload.notification_sent,
      payload.channel || null
    ]
  );
};

const notifyCaregivers = async (pool, userId, { title, message, data }) => {
  const caregiversResult = await pool.query(
    `SELECT CASE WHEN uc.requester_id = $1 THEN uc.addressee_id ELSE uc.requester_id END as caregiver_id
     FROM user_connections uc
     WHERE (uc.requester_id = $1 OR uc.addressee_id = $1)
       AND uc.status = 'accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean, false) = true`,
    [userId]
  );

  if (caregiversResult.rows.length === 0) {
    return { notified: false, status: 'NO_CAREGIVER', message: 'No caregiver linked.' };
  }

  const caregiverIds = caregiversResult.rows.map((row) => row.caregiver_id);
  const tokensResult = await pool.query(
    `SELECT push_token FROM users WHERE id = ANY($1) AND push_token IS NOT NULL`,
    [caregiverIds]
  );

  const tokens = tokensResult.rows.map((row) => row.push_token).filter(Boolean);
  if (tokens.length === 0) {
    return { notified: false, status: 'NO_CAREGIVER', message: 'No caregiver push tokens.' };
  }

  const response = await sendPushNotification(tokens, title, message, data || {});
  return {
    notified: response.ok === true,
    status: response.ok ? 'NOTIFIED' : 'LOGGED',
    message: response.ok ? 'Caregiver notified.' : 'Notification failed.'
  };
};

const buildDecisionPayload = (engineBOutput) => ({
  level: engineBOutput.decision_label,
  code: engineBOutput.decision
});

const getNextState = async (pool, userId) => {
  const now = new Date();
  const tracker = await getActiveTracker(pool, userId);
  const session = await ensureSession(pool, userId, null, tracker);
  const snapshot = await ensureSnapshot(pool, session.id, userId);

  const [lastEvent, lastAnswer, lastEventAt] = await Promise.all([
    getLastEvent(pool, session.id),
    getLastAnswer(pool, session.id),
    getLastBrainEventAt(pool, userId)
  ]);

  let pendingQuestion = null;
  if (lastAnswer?.question_id === 'mood') {
    const moodValue = parseMoodValue(lastAnswer.payload);
    if (moodValue && moodValue !== 'OK') {
      const symptomAnswer = await getAnswerForQuestion(pool, session.id, 'symptom_severity');
      if (!symptomAnswer) pendingQuestion = QUESTIONS.symptom_severity;
    }
  }

  let question = null;
  let shouldAsk = false;

  if (pendingQuestion) {
    question = pendingQuestion;
    shouldAsk = true;
  } else if (!shouldHoldPrompt(tracker, now)) {
    if (!tracker) {
      question = QUESTIONS.mood_morning;
      shouldAsk = true;
    } else {
      const phase = tracker.phase_in_day || (tracker.current_path === 'GREEN' ? 'NIGHT' : 'NOON');
      question = QUESTIONS.mood_followup(phase);
      shouldAsk = true;
    }
  }

  if (question) {
    await recordEvent(pool, {
      sessionId: session.id,
      userId,
      eventType: 'question',
      questionId: question.id,
      payload: { phase_in_day: question.phase_in_day || null }
    });

    await touchSession(pool, session.id, question.id);

    if (tracker) {
      await updateTracker(pool, tracker.id, {
        last_prompt_at: now,
        phase_in_day: question.phase_in_day || tracker.phase_in_day
      });
    }
  }

  const signal = await buildSignal(pool, userId, session.id);
  const riskResult = calculateRisk({
    profile: snapshot?.onboarding,
    persistence: snapshot?.risk_persistence,
    signal
  });

  const { configVersion, params, shadowMode } = await loadActiveConfig(pool);
  const engineBInput = buildEngineBInput({
    profile: snapshot?.onboarding,
    logsSummary: snapshot?.logs_summary,
    riskResult,
    signal,
    lastEventAt
  });
  const engineBOutput = computePsV1(engineBInput, params);

  let notificationSent = false;
  if (!shadowMode && engineBOutput.decision >= 2) {
    const notifyResult = await notifyCaregivers(pool, userId, {
      title: engineBOutput.decision >= 3 ? 'Emergency alert' : 'Care check-in',
      message:
        engineBOutput.decision >= 3
          ? 'User needs immediate attention.'
          : 'Please check in with the user.',
      data: { type: 'asinu_brain_alert', level: engineBOutput.decision_label }
    });
    notificationSent = notifyResult.notified;
  }

  await writeAuditRecord(pool, {
    user_id: userId,
    engine_version: ENGINE_B_VERSION,
    config_version: configVersion,
    shadow_mode: shadowMode,
    input_snapshot: engineBInput,
    computation: {
      P: engineBOutput.P,
      S: engineBOutput.S,
      alert_score: engineBOutput.alert_score,
      decision: engineBOutput.decision,
      decision_label: engineBOutput.decision_label,
      weights_used: engineBOutput.weights_used,
      thresholds_used: engineBOutput.thresholds_used,
      points: engineBOutput.points
    },
    output: {
      decision: engineBOutput.decision,
      decision_label: engineBOutput.decision_label
    },
    explainability_payload: engineBOutput.explainability,
    notification_sent: notificationSent,
    channel: 'api/asinu-brain/next'
  });

  return {
    should_ask: shouldAsk,
    session_id: session.id,
    question: question || undefined,
    decision: buildDecisionPayload(engineBOutput),
    explainability: engineBOutput.explainability
  };
};

const submitAnswer = async (pool, userId, payload) => {
  const session = await ensureSession(pool, userId, payload.session_id, null);

  await recordEvent(pool, {
    sessionId: session.id,
    userId,
    eventType: 'answer',
    questionId: payload.question_id,
    payload: payload.answer
  });

  await markSessionAnswered(pool, session.id);

  const tracker = await getActiveTracker(pool, userId);
  const snapshot = await ensureSnapshot(pool, session.id, userId);

  if (payload.question_id === 'mood') {
    const moodValue = parseMoodValue(payload.answer);
    const path = derivePathFromMood(moodValue);
    const nextPhase = path === 'YELLOW' ? advanceYellowPhase(tracker?.phase_in_day) : path === 'GREEN' ? 'NIGHT' : null;
    const nextDue = computeNextDue(path, nextPhase, new Date());

    if (tracker) {
      await updateTracker(pool, tracker.id, {
        current_path: path,
        phase_in_day: nextPhase,
        locked_session_id: session.id,
        next_due_at: nextDue,
        status: 'ACTIVE'
      });
    } else {
      await createTracker(pool, userId, {
        current_path: path,
        phase_in_day: nextPhase,
        locked_session_id: session.id,
        next_due_at: nextDue,
        last_prompt_at: new Date(),
        status: 'ACTIVE'
      });
    }

    if (moodValue === 'OK') {
      const signal = await buildSignal(pool, userId, session.id);
      const riskResult = calculateRisk({
        profile: snapshot?.onboarding,
        persistence: snapshot?.risk_persistence,
        signal
      });
      await upsertRiskPersistence(pool, userId, {
        risk_score: riskResult.risk_score,
        risk_tier: riskResult.risk_tier,
        last_updated_at: new Date(),
        streak_ok_days: riskResult.streak_ok_days
      });

      const outcome = buildOutcomePayload(riskResult);
      await recordOutcome(pool, { sessionId: session.id, userId, outcome });
      await closeSession(pool, session.id, payload.question_id);
      return { session_id: session.id, outcome };
    }

    await touchSession(pool, session.id, payload.question_id);
    return { session_id: session.id, question: QUESTIONS.symptom_severity };
  }

  if (payload.question_id === 'symptom_severity') {
    const signal = await buildSignal(pool, userId, session.id);
    const riskResult = calculateRisk({
      profile: snapshot?.onboarding,
      persistence: snapshot?.risk_persistence,
      signal
    });

    await upsertRiskPersistence(pool, userId, {
      risk_score: riskResult.risk_score,
      risk_tier: riskResult.risk_tier,
      last_updated_at: new Date(),
      streak_ok_days: riskResult.streak_ok_days
    });

    const outcome = buildOutcomePayload(riskResult);
    await recordOutcome(pool, { sessionId: session.id, userId, outcome });
    await closeSession(pool, session.id, payload.question_id);

    if (tracker) {
      const nextPhase = tracker.current_path === 'YELLOW'
        ? advanceYellowPhase(tracker.phase_in_day)
        : tracker.phase_in_day;
      const nextDue = computeNextDue(tracker.current_path, nextPhase, new Date());
      await updateTracker(pool, tracker.id, {
        phase_in_day: nextPhase,
        next_due_at: nextDue,
        locked_session_id: session.id
      });
    }

    return { session_id: session.id, outcome };
  }

  return { session_id: session.id };
};

const getTimeline = async (pool, userId) => {
  const [eventsResult, outcomesResult] = await Promise.all([
    pool.query(
      `SELECT 'event' as type, session_id, question_id, payload, created_at
       FROM asinu_brain_events
       WHERE user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT 'outcome' as type, session_id, NULL as question_id,
              jsonb_build_object(
                'risk_level', risk_level,
                'notify_caregiver', notify_caregiver,
                'recommended_action', recommended_action,
                'outcome_text', outcome_text,
                'metadata', metadata
              ) as payload,
              created_at
       FROM asinu_brain_outcomes
       WHERE user_id = $1`,
      [userId]
    )
  ]);

  const combined = [...eventsResult.rows, ...outcomesResult.rows].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  return combined.slice(0, 50);
};

const postEmergency = async (pool, userId, payload) => {
  const session = await createSession(pool, userId);
  const now = new Date();

  await recordEvent(pool, {
    sessionId: session.id,
    userId,
    eventType: 'emergency',
    questionId: null,
    payload
  });

  await createTracker(pool, userId, {
    current_path: 'EMERGENCY',
    phase_in_day: null,
    locked_session_id: session.id,
    next_due_at: null,
    last_prompt_at: now,
    status: 'ACTIVE'
  });

  const notifyNeeded = payload.type === 'VERY_UNWELL' || payload.type === 'ALERT_CAREGIVER';
  let notifyStatus = { status: 'LOGGED', message: 'Emergency logged.' };

  if (notifyNeeded) {
    notifyStatus = await notifyCaregivers(pool, userId, {
      title: 'Emergency alert',
      message: 'User requested urgent caregiver support.',
      data: { type: 'asinu_brain_emergency', reason: payload.type }
    });
  }

  const outcome = {
    risk_tier: 'HIGH',
    notify_caregiver: notifyNeeded,
    outcome_text: 'Da ghi nhan yeu cau khan.',
    recommended_action: 'Xin giu binh tinh va lien he nguoi than.',
    metadata: { emergency_type: payload.type }
  };

  await recordOutcome(pool, { sessionId: session.id, userId, outcome });
  await closeSession(pool, session.id, null);

  return {
    status: notifyStatus.status || 'LOGGED',
    message: notifyStatus.message || 'Emergency recorded.'
  };
};

module.exports = {
  getNextState,
  submitAnswer,
  getTimeline,
  postEmergency
};
