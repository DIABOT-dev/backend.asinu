const crypto = require('crypto');
const { calculateRisk } = require('../risk/AsinuRiskEngine');
const { assessClinicalRisk } = require('../risk/AsinuRiskEngineC');
const { computePsV1, DEFAULT_CONFIG } = require('../risk/AsinuRiskEngineB');
const { sendPushNotification } = require('../../src/services/push.notification.service');
const {
  generateMoodQuestion,
  generateFollowupQuestion,
  generateSymptomQuestion,
  aiAssessRiskAndDecision
} = require('./questionGenerator.service');
const {
  generateNextStepOrAssess,
  startHealthCheck,
  processAnswerAndGetNext
} = require('./aiHealthAssessment.service');

// Flag để bật/tắt AI Dynamic Mode
const AI_DYNAMIC_MODE = process.env.AI_DYNAMIC_MODE === 'true' || true; // Bật mặc định

const ENGINE_B_VERSION = 'B-PS-V1';
const SHADOW_ENV_KEYS = ['ASINU_SHADOW_MODE', 'SHADOW_MODE'];

const MOOD_OPTIONS = [
  { value: 'OK', label: 'Ổn' },
  { value: 'TIRED', label: 'Mệt' },
  { value: 'NOT_OK', label: 'Không ổn' }
];

const SYMPTOM_OPTIONS = [
  { value: 'none', label: 'Không có triệu chứng' },
  { value: 'chest_pain', label: 'Đau ngực' },
  { value: 'shortness_of_breath', label: 'Khó thở' },
  { value: 'dizziness', label: 'Chóng mặt' },
  { value: 'fever', label: 'Sốt' },
  { value: 'headache', label: 'Đau đầu' },
  { value: 'nausea', label: 'Buồn nôn' },
  { value: 'other', label: 'Khác' }
];

const SEVERITY_OPTIONS = [
  { value: 'mild', label: 'Nhẹ' },
  { value: 'moderate', label: 'Trung bình' },
  { value: 'severe', label: 'Nặng' }
];

const buildMoodQuestion = (text, phase) => ({
  id: 'mood',
  type: 'single_choice',
  text,
  options: MOOD_OPTIONS,
  phase_in_day: phase || null
});

const QUESTIONS = {
  mood_morning: buildMoodQuestion('Hôm nay bác thấy ổn không?', 'MORNING'),
  mood_followup: (phase) => buildMoodQuestion('Bác thấy ổn hơn chưa?', phase || 'NOON'),
  symptom_severity: {
    id: 'symptom_severity',
    type: 'symptom_severity',
    text: 'Bác có triệu chứng nào và mức độ nào?',
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

/**
 * Lấy conversation history cho AI Dynamic Mode
 */
const getConversationHistory = async (pool, sessionId) => {
  const result = await pool.query(
    `SELECT question_id, payload, created_at
     FROM asinu_brain_events
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );
  
  const history = [];
  let currentQuestion = null;
  
  for (const row of result.rows) {
    if (row.payload?.question_text) {
      // Đây là question event
      currentQuestion = {
        question: row.payload.question_text,
        options: row.payload.options || []
      };
    }
    if (row.payload?.option_id || row.payload?.value) {
      // Đây là answer event
      const answer = row.payload.option_id || row.payload.value;
      const answerLabel = row.payload.label || row.payload.option_label || answer;
      
      if (currentQuestion) {
        history.push({
          ...currentQuestion,
          answer,
          answerLabel
        });
        currentQuestion = null;
      } else {
        // Answer không có question trước đó - tạo entry giả
        history.push({
          question: `Câu hỏi ${history.length + 1}`,
          answer,
          answerLabel
        });
      }
    }
  }
  
  return history;
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
  // TESTING MODE: Giảm thời gian xuống 30 giây để test nhanh
  const TESTING_MODE = process.env.TESTING_MODE === 'true' || true; // Bật mặc định để test
  
  if (TESTING_MODE) {
    console.log('[computeNextDue] TESTING MODE: Next question in 30 seconds');
    // Testing: hỏi lại sau 30 giây
    if (path === 'GREEN') return new Date(now.getTime() + 30 * 1000); // 30 giây
    if (path === 'YELLOW') return new Date(now.getTime() + 30 * 1000); // 30 giây
    if (path === 'RED') return new Date(now.getTime() + 30 * 1000); // 30 giây
    return new Date(now.getTime() + 30 * 1000);
  }
  
  // Production mode: thời gian bình thường
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
  if (!tracker) {
    console.log('[shouldHoldPrompt] No tracker, should NOT hold');
    return false;
  }
  if (tracker.current_path === 'EMERGENCY') {
    console.log('[shouldHoldPrompt] EMERGENCY path, should NOT hold');
    return false;
  }
  if (tracker.dismissed_until && now < new Date(tracker.dismissed_until)) {
    console.log('[shouldHoldPrompt] Dismissed until', tracker.dismissed_until, '- HOLD');
    return true;
  }
  if (tracker.cooldown_until && now < new Date(tracker.cooldown_until)) {
    console.log('[shouldHoldPrompt] Cooldown until', tracker.cooldown_until, '- HOLD');
    return true;
  }
  if (tracker.next_due_at && now < new Date(tracker.next_due_at)) {
    console.log('[shouldHoldPrompt] Next due at', tracker.next_due_at, 'now:', now, '- HOLD');
    return true;
  }
  console.log('[shouldHoldPrompt] All checks passed, should NOT hold');
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

/**
 * Lấy chi tiết mood history trong 48h để AI đánh giá
 */
const getMoodHistory48h = async (pool, userId) => {
  const result = await pool.query(
    `SELECT payload, created_at
     FROM asinu_brain_events
     WHERE user_id = $1
       AND event_type = 'answer'
       AND question_id = 'mood'
       AND created_at >= NOW() - INTERVAL '48 hours'
     ORDER BY created_at DESC`,
    [userId]
  );

  let total = 0;
  let notOkCount = 0;
  let tiredCount = 0;
  let okCount = 0;
  const moods = [];

  for (const row of result.rows) {
    const moodValue = parseMoodValue(row.payload);
    total += 1;
    moods.push({ mood: moodValue, at: row.created_at });
    
    if (moodValue === 'NOT_OK') notOkCount += 1;
    else if (moodValue === 'TIRED') tiredCount += 1;
    else if (moodValue === 'OK') okCount += 1;
  }

  // Determine trend
  let trend = 'STABLE';
  if (moods.length >= 2) {
    const recent = moods.slice(0, 2); // 2 câu trả lời gần nhất
    const recentBad = recent.filter(m => m.mood === 'NOT_OK' || m.mood === 'TIRED').length;
    if (recentBad === 2) trend = 'WORSENING';
    else if (recentBad === 0) trend = 'IMPROVING';
  }

  return {
    total,
    notOkCount,
    tiredCount,
    okCount,
    trend,
    moods // Raw data for AI analysis
  };
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
  let outcomeText = 'Cảm ơn bác đã chia sẻ.';
  let action = 'Tiếp tục theo dõi và sinh hoạt bình thường.';

  if (riskResult.risk_tier === 'HIGH') {
    outcomeText = 'Cần liên hệ người thân để kiểm tra.';
    action = 'Ưu tiên liên hệ người thân và theo dõi sát.';
  } else if (riskResult.risk_tier === 'MEDIUM') {
    outcomeText = 'Cần theo dõi sát hơn trong hôm nay.';
    action = 'Nếu có thay đổi, hãy check-in thêm.';
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
  // Lấy thông tin user để có tên
  const userResult = await pool.query(
    'SELECT full_name, email FROM users WHERE id = $1',
    [userId]
  );
  const userName = userResult.rows[0]?.full_name || userResult.rows[0]?.email || `User ${userId}`;
  
  // Lấy caregivers kèm theo relationship_type và xác định ai là requester
  const caregiversResult = await pool.query(
    `SELECT 
       CASE WHEN uc.requester_id = $1 THEN uc.addressee_id ELSE uc.requester_id END as caregiver_id,
       uc.relationship_type,
       uc.role,
       CASE WHEN uc.requester_id = $1 THEN true ELSE false END as patient_is_requester
     FROM user_connections uc
     WHERE (uc.requester_id = $1 OR uc.addressee_id = $1)
       AND uc.status = 'accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean, false) = true`,
    [userId]
  );

  if (caregiversResult.rows.length === 0) {
    return { notified: false, status: 'NO_CAREGIVER', message: 'No caregiver linked.' };
  }

  // Đảo ngược mối quan hệ: nếu patient đặt caregiver là "Bố" thì caregiver nhìn patient là "Con"
  const reverseRelationship = (relationshipType) => {
    if (!relationshipType) return null;
    
    const reverseMap = {
      // Cha mẹ <-> Con cái
      'bo': 'Con của bạn',
      'Bố': 'Con của bạn',
      'me': 'Con của bạn',
      'Mẹ': 'Con của bạn',
      'con-trai': 'Bố/Mẹ của bạn',
      'Con trai': 'Bố/Mẹ của bạn',
      'con-gai': 'Bố/Mẹ của bạn',
      'Con gái': 'Bố/Mẹ của bạn',
      
      // Vợ chồng (đối xứng)
      'vo': 'Chồng của bạn',
      'Vợ': 'Chồng của bạn',
      'chong': 'Vợ của bạn',
      'Chồng': 'Vợ của bạn',
      
      // Anh chị em
      'anh-trai': 'Em của bạn',
      'Anh trai': 'Em của bạn',
      'chi-gai': 'Em của bạn',
      'Chị gái': 'Em của bạn',
      'em-trai': 'Anh/Chị của bạn',
      'Em trai': 'Anh/Chị của bạn',
      'em-gai': 'Anh/Chị của bạn',
      'Em gái': 'Anh/Chị của bạn',
      
      // Ông bà <-> Cháu
      'ong-noi': 'Cháu của bạn',
      'Ông nội': 'Cháu của bạn',
      'ba-noi': 'Cháu của bạn',
      'Bà nội': 'Cháu của bạn',
      'ong-ngoai': 'Cháu của bạn',
      'Ông ngoại': 'Cháu của bạn',
      'ba-ngoai': 'Cháu của bạn',
      'Bà ngoại': 'Cháu của bạn',
      
      // Bạn bè, người yêu (đối xứng)
      'ban-than': 'Bạn thân của bạn',
      'Bạn thân': 'Bạn thân của bạn',
      'nguoi-yeu': 'Người yêu của bạn',
      'Người yêu': 'Người yêu của bạn',
    };
    
    return reverseMap[relationshipType] || null;
  };

  // Lấy label gốc cho relationship
  const getOriginalLabel = (relationshipType) => {
    if (!relationshipType) return null;
    
    const labelMap = {
      'bo': 'Bố của bạn',
      'Bố': 'Bố của bạn',
      'me': 'Mẹ của bạn',
      'Mẹ': 'Mẹ của bạn',
      'con-trai': 'Con trai của bạn',
      'Con trai': 'Con trai của bạn',
      'con-gai': 'Con gái của bạn',
      'Con gái': 'Con gái của bạn',
      'vo': 'Vợ của bạn',
      'Vợ': 'Vợ của bạn',
      'chong': 'Chồng của bạn',
      'Chồng': 'Chồng của bạn',
      'anh-trai': 'Anh trai của bạn',
      'Anh trai': 'Anh trai của bạn',
      'chi-gai': 'Chị gái của bạn',
      'Chị gái': 'Chị gái của bạn',
      'em-trai': 'Em trai của bạn',
      'Em trai': 'Em trai của bạn',
      'em-gai': 'Em gái của bạn',
      'Em gái': 'Em gái của bạn',
      'ong-noi': 'Ông nội của bạn',
      'Ông nội': 'Ông nội của bạn',
      'ba-noi': 'Bà nội của bạn',
      'Bà nội': 'Bà nội của bạn',
      'ong-ngoai': 'Ông ngoại của bạn',
      'Ông ngoại': 'Ông ngoại của bạn',
      'ba-ngoai': 'Bà ngoại của bạn',
      'Bà ngoại': 'Bà ngoại của bạn',
      'ban-than': 'Bạn thân của bạn',
      'Bạn thân': 'Bạn thân của bạn',
      'nguoi-yeu': 'Người yêu của bạn',
      'Người yêu': 'Người yêu của bạn',
    };
    
    return labelMap[relationshipType] || null;
  };

  // Xác định relationship label theo góc nhìn của caregiver
  const getRelationshipForCaregiver = (relationshipType, patientIsRequester) => {
    // Nếu patient là requester (người đặt relationship) 
    // → caregiver nhìn patient theo relationship đảo ngược
    // Ví dụ: Patient đặt caregiver là "Bố" → caregiver nhìn patient là "Con"
    if (patientIsRequester) {
      return reverseRelationship(relationshipType) || 'Người thân của bạn';
    }
    // Nếu caregiver là requester (người đặt relationship)
    // → caregiver nhìn patient theo relationship gốc
    // Ví dụ: Caregiver đặt patient là "Bố" → caregiver nhìn patient là "Bố"
    return getOriginalLabel(relationshipType) || 'Người thân của bạn';
  };
  
  // 1. TẠO IN-APP NOTIFICATION cho mọi người thân (personalized)
  for (const caregiver of caregiversResult.rows) {
    const relationLabel = getRelationshipForCaregiver(
      caregiver.relationship_type, 
      caregiver.patient_is_requester
    );
    
    // Personalize message với mối quan hệ
    const personalizedTitle = title.replace(userName, relationLabel);
    const personalizedMessage = message.replace(new RegExp(userName, 'g'), relationLabel);
    
    await pool.query(
      `INSERT INTO notifications (
        user_id, type, title, message, data, is_read, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        caregiver.caregiver_id,
        'health_alert',
        personalizedTitle,
        personalizedMessage,
        JSON.stringify({
          patientUserId: userId,
          patientName: userName,
          relationship: relationLabel,
          alertType: data?.alertType || 'general',
          severity: data?.severity || 'medium',
          timestamp: new Date().toISOString()
        }),
        false
      ]
    );
  }
  
  // 2. GỬI PUSH NOTIFICATION (personalized cho từng người)
  const caregiverIds = caregiversResult.rows.map(r => r.caregiver_id);
  const tokensResult = await pool.query(
    `SELECT id, push_token FROM users WHERE id = ANY($1) AND push_token IS NOT NULL`,
    [caregiverIds]
  );

  let pushNotified = false;
  for (const tokenRow of tokensResult.rows) {
    const caregiver = caregiversResult.rows.find(c => c.caregiver_id === tokenRow.id);
    if (!caregiver || !tokenRow.push_token) continue;
    
    // Sử dụng cùng logic như in-app notification
    const relationLabel = getRelationshipForCaregiver(
      caregiver.relationship_type, 
      caregiver.patient_is_requester
    );
    const personalizedTitle = title.replace(userName, relationLabel);
    const personalizedMessage = message.replace(new RegExp(userName, 'g'), relationLabel);
    
    const response = await sendPushNotification(
      [tokenRow.push_token],
      personalizedTitle,
      personalizedMessage,
      {
        ...data,
        patientUserId: userId,
        patientName: userName,
        relationship: relationLabel,
        type: 'health_alert',
        screen: 'notifications'
      }
    );
    if (response.ok) pushNotified = true;
  }
  
  console.log(`[notifyCaregivers] Notified ${caregiverIds.length} caregivers (in-app + push: ${pushNotified})`);
  console.log(`[notifyCaregivers] ⚠️ ALERT SENT - Risk: ${data.riskLevel}, Patient: ${userName}`);
  
  return {
    notified: true,
    inAppCreated: caregiverIds.length,
    pushSent: pushNotified,
    status: 'NOTIFIED',
    message: `Created ${caregiverIds.length} in-app notifications${pushNotified ? ' and sent push' : ''}.`
  };
};

const buildDecisionPayload = (engineBOutput) => ({
  level: engineBOutput.decision_label,
  code: engineBOutput.decision
});

/**
 * Kiểm tra xem hôm nay user đã có logs chưa
 * Return { hasLogs: boolean, message: string }
 */
const checkTodayLogs = async (pool, userId) => {
  // Dùng timezone VN (UTC+7) để xác định "hôm nay"
  // hoặc dùng CURRENT_DATE của PostgreSQL (theo timezone server)
  
  console.log(`[checkTodayLogs] Checking logs for userId: ${userId}`);
  
  // Check glucose logs hôm nay
  const glucoseResult = await pool.query(
    `SELECT COUNT(*) FROM logs_common lc
     INNER JOIN glucose_logs gl ON lc.id = gl.log_id
     WHERE lc.user_id = $1 
       AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = CURRENT_DATE`,
    [userId]
  );
  
  // Check blood pressure logs hôm nay
  const bpResult = await pool.query(
    `SELECT COUNT(*) FROM logs_common lc
     INNER JOIN blood_pressure_logs bpl ON lc.id = bpl.log_id
     WHERE lc.user_id = $1 
       AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = CURRENT_DATE`,
    [userId]
  );
  
  const hasGlucose = parseInt(glucoseResult.rows[0].count) > 0;
  const hasBP = parseInt(bpResult.rows[0].count) > 0;
  
  console.log(`[checkTodayLogs] userId ${userId} - Glucose logs today: ${glucoseResult.rows[0].count}, BP logs today: ${bpResult.rows[0].count}`);
  console.log(`[checkTodayLogs] userId ${userId} - hasGlucose: ${hasGlucose}, hasBP: ${hasBP}`);
  
  if (!hasGlucose && !hasBP) {
    console.log(`[checkTodayLogs] userId ${userId} - NO LOGS TODAY (neither glucose nor BP)`);
    return {
      hasLogs: false,
      message: 'Vui lòng ghi lại đường huyết hoặc huyết áp hôm nay trước để chúng tôi có thể đánh giá sức khỏe của bạn.',
      missingTypes: ['đường huyết', 'huyết áp']
    };
  }
  
  if (!hasGlucose) {
    console.log(`[checkTodayLogs] userId ${userId} - MISSING GLUCOSE (has BP only)`);
    return {
      hasLogs: false,
      message: 'Vui lòng ghi lại đường huyết hôm nay để chúng tôi theo dõi tình trạng của bạn.',
      missingTypes: ['đường huyết']
    };
  }
  
  if (!hasBP) {
    console.log(`[checkTodayLogs] userId ${userId} - MISSING BP (has glucose only)`);
    return {
      hasLogs: false,
      message: 'Vui lòng ghi lại huyết áp hôm nay để chúng tôi theo dõi sức khỏe của bạn.',
      missingTypes: ['huyết áp']
    };
  }
  
  console.log(`[checkTodayLogs] userId ${userId} - HAS ALL LOGS ✓ (glucose + BP)`);
  return { hasLogs: true };
};

const getNextState = async (pool, userId) => {
  const now = new Date();
  
  // KHÔNG chặn user vì thiếu logs - chỉ dùng logs làm tiêu chí đánh giá
  // Engine C sẽ gracefully degrade khi không có logs
  
  const tracker = await getActiveTracker(pool, userId);
  const session = await ensureSession(pool, userId, null, tracker);
  const snapshot = await ensureSnapshot(pool, session.id, userId);

  // ========== AI DYNAMIC MODE ==========
  if (AI_DYNAMIC_MODE) {
    console.log(`[getNextState] AI_DYNAMIC_MODE enabled for user ${userId}`);
    
    // Kiểm tra nếu đang giữ prompt
    if (shouldHoldPrompt(tracker, now)) {
      return {
        should_ask: false,
        session_id: session.id,
        decision: { level: 'NONE', code: 0 },
        notification_sent: false
      };
    }
    
    // Lấy conversation history và mood history
    const [conversationHistory, moodHistory] = await Promise.all([
      getConversationHistory(pool, session.id),
      getMoodHistory48h(pool, userId)
    ]);
    
    console.log(`[getNextState] Conversation history length: ${conversationHistory.length}`);
    
    // Gọi AI để sinh câu hỏi đầu tiên hoặc tiếp theo
    const aiResult = await startHealthCheck({
      userId,
      profile: snapshot?.onboarding,
      logsSummary: snapshot?.logs_summary,
      moodHistory
    });
    
    if (aiResult.continue) {
      // AI muốn hỏi thêm
      const question = aiResult.question;
      
      // Record question event với đầy đủ thông tin
      await recordEvent(pool, {
        sessionId: session.id,
        userId,
        eventType: 'question',
        questionId: question.id,
        payload: { 
          question_text: question.text,
          options: question.options,
          step: question.step,
          generated_by_ai: question.generated_by_ai
        }
      });
      
      await touchSession(pool, session.id, question.id);
      
      if (tracker) {
        await updateTracker(pool, tracker.id, {
          last_prompt_at: now,
          locked_session_id: session.id
        });
      } else {
        await createTracker(pool, userId, {
          current_path: 'GREEN', // Bắt đầu với GREEN, sẽ update dựa vào assessment
          locked_session_id: session.id,
          last_prompt_at: now,
          status: 'ACTIVE'
        });
      }
      
      return {
        should_ask: true,
        session_id: session.id,
        question: {
          id: question.id,
          type: question.type,
          text: question.text,
          options: question.options
        },
        question_flow: {
          step: question.step || 1,
          total: 7, // Max 7 câu
          mode: 'dynamic' // Đánh dấu là dynamic mode
        },
        decision: { level: 'NONE', code: 0 },
        notification_sent: false
      };
    } else {
      // AI đã đánh giá xong (không có hội thoại nào)
      console.log(`[getNextState] AI assessed without questions - unusual case`);
      return {
        should_ask: false,
        session_id: session.id,
        decision: { level: 'NONE', code: 0 },
        notification_sent: false
      };
    }
  }
  
  // ========== LEGACY MODE (fallback) ==========
  const [lastEvent, lastAnswer, lastEventAt] = await Promise.all([
    getLastEvent(pool, session.id),
    getLastAnswer(pool, session.id),
    getLastBrainEventAt(pool, userId)
  ]);

  // Build question flow với context từ previous answers
  let pendingQuestion = null;
  let questionFlow = {
    step: 1,
    total: 1,
    previousAnswers: {}
  };

  if (lastAnswer?.question_id === 'mood') {
    const moodValue = parseMoodValue(lastAnswer.payload);
    questionFlow.previousAnswers.mood = { value: moodValue, text: MOOD_OPTIONS.find(o => o.value === moodValue)?.label };
    
    if (moodValue && moodValue !== 'OK') {
      const symptomAnswer = await getAnswerForQuestion(pool, session.id, 'symptom_severity');
      if (!symptomAnswer) {
        // Generate AI question for symptoms - WITH CONTEXT từ mood answer
        questionFlow.step = 2;
        questionFlow.total = 2;
        pendingQuestion = await generateSymptomQuestion(pool, userId, {
          logsSummary: snapshot?.logs_summary,
          profile: snapshot?.onboarding,
          mood: moodValue,
          previousAnswer: questionFlow.previousAnswers.mood // Pass context
        });
      }
    }
  }

  let question = null;
  let shouldAsk = false;

  if (pendingQuestion) {
    question = pendingQuestion;
    shouldAsk = true;
  } else if (!shouldHoldPrompt(tracker, now)) {
    if (!tracker) {
      // Generate AI question for morning mood
      question = await generateMoodQuestion(pool, userId, 'MORNING', {
        logsSummary: snapshot?.logs_summary,
        profile: snapshot?.onboarding,
        riskLevel: snapshot?.risk_persistence?.risk_tier
      });
      shouldAsk = true;
    } else {
      const phase = tracker.phase_in_day || (tracker.current_path === 'GREEN' ? 'NIGHT' : 'NOON');
      // Generate AI question for followup
      question = await generateFollowupQuestion(pool, userId, phase, {
        logsSummary: snapshot?.logs_summary,
        profile: snapshot?.onboarding,
        riskLevel: snapshot?.risk_persistence?.risk_tier,
        previousMood: lastAnswer ? parseMoodValue(lastAnswer.payload) : null
      });
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
  
  // Sử dụng Engine C - đánh giá dựa trên chỉ số lâm sàng thực tế
  const clinicalRisk = assessClinicalRisk({
    glucose: snapshot?.logs_summary?.latest_glucose,
    bloodPressure: snapshot?.logs_summary?.latest_bp,
    mood: signal?.today_mood,
    symptoms: [] // Sẽ lấy từ answers nếu có
  });
  
  // Giữ lại calculateRisk cũ để backward compatible
  const riskResult = {
    ...calculateRisk({
      profile: snapshot?.onboarding,
      persistence: snapshot?.risk_persistence,
      signal
    }),
    // Override bằng kết quả từ Engine C
    risk_tier: clinicalRisk.risk_tier,
    risk_score: clinicalRisk.risk_score,
    notify_caregiver: clinicalRisk.notify_caregiver,
    clinical_assessment: clinicalRisk.clinical_assessment,
    engine_version: 'C'
  };

  const { configVersion, params, shadowMode } = await loadActiveConfig(pool);
  const engineBInput = buildEngineBInput({
    profile: snapshot?.onboarding,
    logsSummary: snapshot?.logs_summary,
    riskResult,
    signal,
    lastEventAt
  });
  const engineBOutput = computePsV1(engineBInput, params);

  // CHUYỂN notification logic - CHỈ gửi SAU KHI hoàn thành session
  // Không gửi ở đây vì user chưa trả lời xong
  let notificationSent = false;
  const shouldNotify = !shadowMode && engineBOutput.decision >= 2 && !pendingQuestion;
  
  if (shouldNotify) {
    // Session đã hoàn thành (không còn pending question)
    // Lấy tên bệnh nhân - sẽ được replace bằng mối quan hệ trong notifyCaregivers
    const userResult = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [userId]);
    const patientName = userResult.rows[0]?.full_name || 'Người thân';
    
    const notifyResult = await notifyCaregivers(pool, userId, {
      title: engineBOutput.decision >= 3 
        ? `[KHẨN CẤP] ${patientName} - Cảnh báo sức khỏe` 
        : `[CẢNH BÁO] ${patientName} - Sức khỏe`,
      message:
        engineBOutput.decision >= 3
          ? `${patientName} đang có dấu hiệu sức khỏe lo ngại. Vui lòng liên hệ kiểm tra ngay.`
          : `${patientName} cần được theo dõi sức khỏe. Hãy liên hệ hỏi thăm.`,
      data: { 
        type: 'health_alert', 
        level: engineBOutput.decision_label,
        session_id: session.id,
        timestamp: now.toISOString()
      }
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
    question_flow: questionFlow, // Thêm flow info cho UI
    decision: buildDecisionPayload(engineBOutput),
    explainability: engineBOutput.explainability,
    notification_sent: notificationSent
  };
};

const submitAnswer = async (pool, userId, payload) => {
  const session = await ensureSession(pool, userId, payload.session_id, null);
  const snapshot = await ensureSnapshot(pool, session.id, userId);
  
  // ========== AI DYNAMIC MODE ==========
  if (AI_DYNAMIC_MODE) {
    console.log(`[submitAnswer] AI_DYNAMIC_MODE - Question: ${payload.question_id}`);
    
    // Lấy label cho answer từ question nếu có
    let answerLabel = payload.answer?.label || payload.answer?.option_id || payload.answer?.value;
    
    // Record answer event
    await recordEvent(pool, {
      sessionId: session.id,
      userId,
      eventType: 'answer',
      questionId: payload.question_id,
      payload: {
        ...payload.answer,
        label: answerLabel
      }
    });
    
    await markSessionAnswered(pool, session.id);
    
    // Lấy conversation history và mood history
    const [conversationHistory, moodHistory] = await Promise.all([
      getConversationHistory(pool, session.id),
      getMoodHistory48h(pool, userId)
    ]);
    
    console.log(`[submitAnswer] Processing answer, history length: ${conversationHistory.length}`);
    
    // Gọi AI để quyết định bước tiếp theo
    const aiResult = await generateNextStepOrAssess({
      userId,
      conversationHistory,
      profile: snapshot?.onboarding,
      logsSummary: snapshot?.logs_summary,
      moodHistory
    });
    
    console.log(`[submitAnswer] AI Result: continue=${aiResult.continue}`);
    
    if (aiResult.continue) {
      // AI muốn hỏi thêm
      const question = aiResult.question;
      
      // Record question event
      await recordEvent(pool, {
        sessionId: session.id,
        userId,
        eventType: 'question',
        questionId: question.id,
        payload: {
          question_text: question.text,
          options: question.options,
          step: question.step,
          generated_by_ai: question.generated_by_ai
        }
      });
      
      await touchSession(pool, session.id, question.id);
      
      return {
        session_id: session.id,
        question: {
          id: question.id,
          type: question.type,
          text: question.text,
          options: question.options
        },
        question_flow: {
          step: question.step || conversationHistory.length + 1,
          total: 7,
          mode: 'dynamic'
        }
      };
    } else {
      // AI đã đánh giá xong
      const assessment = aiResult.assessment;
      console.log(`[submitAnswer] AI Assessment:`, assessment);
      
      // Update risk persistence
      await upsertRiskPersistence(pool, userId, {
        risk_score: assessment.risk_score,
        risk_tier: assessment.risk_tier,
        last_updated_at: new Date(),
        streak_ok_days: assessment.risk_tier === 'LOW' ? 
          (snapshot?.risk_persistence?.streak_ok_days || 0) + 1 : 0
      });
      
      const outcome = {
        risk_tier: assessment.risk_tier,
        notify_caregiver: assessment.notify_caregiver,
        outcome_text: assessment.outcome_text,
        recommended_action: assessment.recommended_action,
        metadata: {
          ai_reasoning: aiResult.reasoning,
          assessed_by: assessment.assessed_by || 'AI',
          total_questions: assessment.total_questions,
          summary: assessment.summary
        }
      };
      
      await recordOutcome(pool, { sessionId: session.id, userId, outcome });
      
      // GỬI THÔNG BÁO nếu AI quyết định
      if (assessment.notify_caregiver) {
        console.log(`[submitAnswer] ⚠️ AI quyết định GỬI CẢNH BÁO cho người thân`);
        console.log(`  - Risk: ${assessment.risk_tier}, Score: ${assessment.risk_score}`);
        console.log(`  - Reason: ${assessment.summary}`);
        
        // Lấy tên bệnh nhân để notifyCaregivers replace bằng mối quan hệ
        const userResult = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [userId]);
        const patientName = userResult.rows[0]?.full_name || 'Người thân';
        
        await notifyCaregivers(pool, userId, {
          title: assessment.risk_tier === 'HIGH' 
            ? `[KHẨN CẤP] ${patientName} - Cần kiểm tra`
            : `[CẢNH BÁO] ${patientName} - Sức khỏe`,
          message: `${patientName} ${assessment.summary || 'cần được kiểm tra sức khỏe.'}`,
          data: {
            riskLevel: assessment.risk_tier,
            sessionId: session.id,
            severity: assessment.risk_tier === 'HIGH' ? 'critical' : 'medium'
          }
        });
      }
      
      // Update tracker
      const tracker = await getActiveTracker(pool, userId);
      const nextDue = computeNextDue(
        assessment.risk_tier === 'HIGH' ? 'RED' : 
        assessment.risk_tier === 'MEDIUM' ? 'YELLOW' : 'GREEN',
        null,
        new Date()
      );
      
      if (tracker) {
        await updateTracker(pool, tracker.id, {
          current_path: assessment.risk_tier === 'HIGH' ? 'RED' : 
                        assessment.risk_tier === 'MEDIUM' ? 'YELLOW' : 'GREEN',
          next_due_at: nextDue,
          locked_session_id: session.id
        });
      }
      
      await closeSession(pool, session.id, payload.question_id);
      
      return {
        session_id: session.id,
        outcome: {
          risk_tier: assessment.risk_tier,
          outcome_text: assessment.outcome_text,
          recommended_action: assessment.recommended_action,
          notify_caregiver: assessment.notify_caregiver
        }
      };
    }
  }
  
  // ========== LEGACY MODE (fallback) ==========
  await recordEvent(pool, {
    sessionId: session.id,
    userId,
    eventType: 'answer',
    questionId: payload.question_id,
    payload: payload.answer
  });

  await markSessionAnswered(pool, session.id);

  const tracker = await getActiveTracker(pool, userId);
  const legacySnapshot = await ensureSnapshot(pool, session.id, userId);

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
      // Lấy mood history để AI đánh giá
      const moodHistory = await getMoodHistory48h(pool, userId);
      
      // SỬ DỤNG AI để đánh giá và quyết định
      const aiDecision = await aiAssessRiskAndDecision(pool, userId, {
        logsSummary: legacySnapshot?.logs_summary,
        profile: legacySnapshot?.onboarding,
        moodHistory,
        currentMood: 'OK',
        symptoms: [],
        symptomSeverity: null
      });
      
      console.log(`[submitAnswer] AI Decision for mood=OK:`, aiDecision);
      
      await upsertRiskPersistence(pool, userId, {
        risk_score: aiDecision.risk_score,
        risk_tier: aiDecision.risk_tier,
        last_updated_at: new Date(),
        streak_ok_days: (legacySnapshot?.risk_persistence?.streak_ok_days || 0) + 1
      });

      const outcome = {
        risk_tier: aiDecision.risk_tier,
        notify_caregiver: aiDecision.notify_caregiver,
        outcome_text: aiDecision.outcome_text,
        recommended_action: aiDecision.recommended_action,
        metadata: {
          ai_reasoning: aiDecision.ai_reasoning,
          assessed_by: aiDecision.assessed_by
        }
      };
      
      await recordOutcome(pool, { sessionId: session.id, userId, outcome });
      
      // GỬI THÔNG BÁO cho người thân nếu AI quyết định
      if (aiDecision.notify_caregiver) {
        console.log(`[submitAnswer] ⚠️ AI quyết định GỬI CẢNH BÁO cho người thân`);
        await notifyCaregivers(pool, userId, {
          title: '[CẢNH BÁO] Cần kiểm tra sức khỏe',
          message: aiDecision.ai_reasoning,
          data: { riskLevel: aiDecision.risk_tier, sessionId: session.id }
        });
      }
      
      await closeSession(pool, session.id, payload.question_id);
      return { session_id: session.id, outcome };
    }

    await touchSession(pool, session.id, payload.question_id);
    // Generate AI symptom question based on mood response
    const symptomQuestion = await generateSymptomQuestion(pool, userId, {
      logsSummary: legacySnapshot?.logs_summary,
      profile: legacySnapshot?.onboarding,
      mood: moodValue
    });
    return { session_id: session.id, question: symptomQuestion };
  }

  if (payload.question_id === 'symptom_severity') {
    // Lấy symptoms từ answer
    const symptomsList = Array.isArray(payload.answer?.option_id)
      ? payload.answer.option_id
      : [];
    const symptomSeverity = payload.answer?.value;
    
    // Lấy mood history để AI đánh giá
    const moodHistory = await getMoodHistory48h(pool, userId);
    const lastMoodAnswer = await getAnswerForQuestion(pool, session.id, 'mood');
    const currentMood = parseMoodValue(lastMoodAnswer?.payload);
    
    // SỬ DỤNG AI để đánh giá và quyết định
    const aiDecision = await aiAssessRiskAndDecision(pool, userId, {
      logsSummary: legacySnapshot?.logs_summary,
      profile: legacySnapshot?.onboarding,
      moodHistory,
      currentMood,
      symptoms: symptomsList,
      symptomSeverity
    });
    
    console.log(`[submitAnswer] AI Decision for symptoms:`, aiDecision);
    console.log(`  - Symptoms: ${symptomsList.join(', ')}`);
    console.log(`  - Severity: ${symptomSeverity}`);
    console.log(`  - Mood history: ${moodHistory.tiredCount} tired, ${moodHistory.notOkCount} not_ok in 48h`);
    
    await upsertRiskPersistence(pool, userId, {
      risk_score: aiDecision.risk_score,
      risk_tier: aiDecision.risk_tier,
      last_updated_at: new Date(),
      streak_ok_days: 0 // Reset vì có symptoms
    });

    const outcome = {
      risk_tier: aiDecision.risk_tier,
      notify_caregiver: aiDecision.notify_caregiver,
      outcome_text: aiDecision.outcome_text,
      recommended_action: aiDecision.recommended_action,
      metadata: {
        ai_reasoning: aiDecision.ai_reasoning,
        assessed_by: aiDecision.assessed_by,
        symptoms: symptomsList,
        severity: symptomSeverity
      }
    };
    
    await recordOutcome(pool, { sessionId: session.id, userId, outcome });
    
    // GỬI THÔNG BÁO cho người thân nếu AI quyết định
    if (aiDecision.notify_caregiver) {
      console.log(`[submitAnswer] ⚠️ AI quyết định GỬI CẢNH BÁO cho người thân`);
      console.log(`  - Risk: ${aiDecision.risk_tier}, Score: ${aiDecision.risk_score}`);
      console.log(`  - Reason: ${aiDecision.ai_reasoning}`);
      
      await notifyCaregivers(pool, userId, {
        title: '[KHẨN CẤP] Cảnh báo sức khỏe',
        message: `Cần kiểm tra: ${aiDecision.ai_reasoning}`,
        data: { 
          riskLevel: aiDecision.risk_tier, 
          sessionId: session.id,
          symptoms: symptomsList,
          severity: symptomSeverity
        }
      });
    }
    
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
    // Lấy tên bệnh nhân để gửi trong notification
    const userResult = await pool.query(
      'SELECT full_name, email FROM users WHERE id = $1',
      [userId]
    );
    const userName = userResult.rows[0]?.full_name || userResult.rows[0]?.email || `User ${userId}`;
    
    // Map emergency type sang message tiếng Việt - userName sẽ được replace bằng mối quan hệ
    const emergencyMessages = {
      'VERY_UNWELL': {
        title: `[KHẨN CẤP] ${userName}`,
        message: `${userName} đang rất không khỏe và cần hỗ trợ ngay lập tức. Vui lòng gọi điện hoặc đến kiểm tra ngay.`
      },
      'ALERT_CAREGIVER': {
        title: `[YÊU CẦU] ${userName}`,
        message: `${userName} yêu cầu bạn liên hệ ngay. Hãy gọi điện hoặc nhắn tin kiểm tra tình hình.`
      }
    };
    
    const notificationContent = emergencyMessages[payload.type] || {
      title: `[CẢNH BÁO] ${userName}`,
      message: `${userName} cần hỗ trợ từ bạn. Vui lòng liên hệ.`
    };
    
    notifyStatus = await notifyCaregivers(pool, userId, {
      title: notificationContent.title,
      message: notificationContent.message,
      data: { 
        alertType: 'emergency',
        emergencyType: payload.type,
        severity: 'critical',
        requiresImmediate: true,
        patientName: userName,
        patientUserId: userId
      }
    });
  }

  const outcome = {
    risk_tier: 'HIGH',
    notify_caregiver: notifyNeeded,
    outcome_text: 'Đã ghi nhận yêu cầu khẩn.',
    recommended_action: 'Xin giữ bình tĩnh và liên hệ người thân.',
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
