/**
 * Health Check-in Service
 *
 * Flow states:
 *   monitoring  — "Tôi ổn", check lại lúc 21h
 *   follow_up   — "Hơi mệt", check lại sau 3h → 4h
 *   high_alert  — "Rất mệt", check lại sau 2h
 *   resolved    — Người dùng xác nhận đã ổn
 *
 * No-response escalation (smart alert via shouldAlertFamily):
 *   miss × 1 → push nhắc
 *   miss × 2+ → smart decision based on severity, age, time of day, history
 *     - high_severity → always alert
 *     - elderly (65+) → alert after 1 miss
 *     - nighttime (22h-6h) → alert after 1 miss
 *     - habitual non-responder → alert after 3 misses
 *     - normal user → alert after 2 misses
 *   miss × 4+ → mark resolved to stop spamming
 */

const { sendPushNotification } = require('../notification/push.notification.service');
const { getPatientRoleForCaregiver } = require('../../lib/relation');
const { getNextTriageQuestion, buildContinuityMessage, calcFollowUpHours } = require('./checkin.ai.service');
const { saveSymptomLogs } = require('./symptom-tracker.service');
const { dispatch: dispatchNotification } = require('../../core/notification/notification.orchestrator');
const { trackEvent } = require('../profile/engagement.service');
const { updateMissionProgress } = require('../missions/missions.service');
const { t } = require('../../i18n');
const { getHonorifics } = require('../../lib/honorifics');
const { cacheGet, cacheSet, cacheDel } = require('../../lib/redis');
const { buildCheckinContext, applyIllusion } = require('../../core/checkin/illusion-layer');

// ─── Priority map ────────────────────────────────────────────────
const TYPE_PRIORITY = {
  emergency: 'critical',
  checkin_followup_urgent: 'critical',
  health_alert: 'high',
  caregiver_alert: 'high',
  checkin_followup: 'high',
  morning_checkin: 'medium',
  care_circle_invitation: 'medium',
  care_circle_accepted: 'medium',
  reminder_glucose: 'medium',
  reminder_bp: 'medium',
  reminder_medication: 'medium',
  reminder_afternoon: 'low',
  reminder_morning: 'low',
  evening_checkin: 'low',
  caregiver_confirmed: 'low',
  milestone: 'low',
  streak_start: 'low',
  streak_milestone: 'low',
  weekly_recap: 'low',
  engagement: 'low',
};

/**
 * Send push notification AND save in-app notification to DB.
 * @param {object} pool
 * @param {number} userId - recipient user id
 * @param {string|null} pushToken - may be null (skip push)
 * @param {string} type
 * @param {string} title
 * @param {string} body
 * @param {object} data
 */
async function sendCheckinNotification(pool, userId, pushToken, type, title, body, data = {}) {
  const priority = TYPE_PRIORITY[type] || 'low';

  // Orchestrator controls cooldown — only send push if DB insert succeeds
  let dispatched = null;
  try {
    dispatched = await dispatchNotification(pool, { userId, type, title, body, data, priority });
    console.log(`[NOTIF] dispatchNotification type=${type} userId=${userId} ok=${dispatched?.ok} id=${dispatched?.notificationId}`);
  } catch (e) {
    console.error(`[NOTIF] dispatchNotification FAILED:`, e.message);
    return;
  }

  if (!dispatched) {
    console.log(`[NOTIF] push skipped type=${type} userId=${userId} — cooldown`);
    return;
  }

  if (pushToken) {
    try {
      const r = await sendPushNotification([pushToken], title, body, { type, ...data });
      console.log(`[NOTIF] push type=${type} userId=${userId} ok=${r?.ok}`);
    } catch (e) {
      console.error(`[NOTIF] push FAILED:`, e.message);
    }
  }
}

const TZ = 'Asia/Ho_Chi_Minh';

// Ngưỡng risk score để cảnh báo gia đình tự động
const FAMILY_ALERT_RISK_THRESHOLD = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Lấy tên ngắn từ full name (tên cuối cùng trong tên Việt Nam).
 * "Dương Anh Đức" → "Đức"
 * "Nguyễn Thị Mai" → "Mai"
 */
function getShortName(fullName) {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1];
}

function nowVN() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

/** 21:00 VN time today — fixed timezone calculation */
function todayEvening9pm() {
  const vnDateStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const t = new Date(`${vnDateStr}T21:00:00+07:00`);
  // If already past 21:00 VN, push to tomorrow 21:00
  return t <= new Date() ? new Date(t.getTime() + 24 * 60 * 60 * 1000) : t;
}

/** now + hours in UTC */
function hoursFromNow(h) {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

function todayVN() {
  return nowVN().toISOString().slice(0, 10);
}

/** Check-in session date: resets at 05:00 VN (not midnight).
 *  Before 05:00 → use previous calendar day. */
function checkinDateVN() {
  const vn = nowVN();
  if (vn.getHours() < 5) {
    vn.setDate(vn.getDate() - 1);
  }
  return vn.toISOString().slice(0, 10);
}

/** Calculate next follow-up time based on flow + checkin count */
function calcNextCheckin(flowState, currentStatus, followUpCount = 0, followUpHoursFromAI = null) {
  if (flowState === 'resolved') return null;
  if (flowState === 'monitoring') return todayEvening9pm();
  // Nếu AI trả về followUpHours → dùng luôn
  if (followUpHoursFromAI) return hoursFromNow(followUpHoursFromAI);
  if (flowState === 'high_alert')  return hoursFromNow(followUpCount === 0 ? 1 : 2);
  // follow_up: first = 3h, subsequent = 4h
  return hoursFromNow(followUpCount === 0 ? 3 : 4);
}

// ─── Get yesterday's session ─────────────────────────────────────────────────

/**
 * Lấy session ngày hôm qua (dùng cho Continuity Check).
 */
async function getYesterdaySession(pool, userId) {
  // Dùng cùng logic 5AM boundary như checkinDateVN, rồi trừ 1 ngày
  const vn = nowVN();
  if (vn.getHours() < 5) vn.setDate(vn.getDate() - 1); // adjust for 5AM boundary
  vn.setDate(vn.getDate() - 1); // yesterday relative to checkin date
  const yesterday = vn.toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT session_date, initial_status, triage_summary, triage_severity, flow_state
     FROM health_checkins WHERE user_id = $1 AND session_date = $2`,
    [userId, yesterday]
  );
  return rows[0] || null;
}

// ─── Get today's session ─────────────────────────────────────────────────────

async function getTodayCheckin(pool, userId) {
  const [sessionRes, profileRes, yesterdaySession] = await Promise.all([
    pool.query(
      `SELECT * FROM health_checkins WHERE user_id = $1 AND session_date = $2`,
      [userId, checkinDateVN()]
    ),
    pool.query(
      `SELECT COALESCE(language_preference, 'vi') AS lang FROM users WHERE id = $1`,
      [userId]
    ),
    getYesterdaySession(pool, userId),
  ]);

  const session = sessionRes.rows[0] || null;
  const lang = profileRes.rows[0]?.lang || 'vi';
  const continuityMessage = buildContinuityMessage(yesterdaySession, lang);

  return { session, continuityMessage };
}

// ─── Start / record initial check-in ─────────────────────────────────────────

/**
 * Create or update today's check-in with user's initial status.
 * Called when user responds to morning push or taps "Update sức khoẻ".
 */
async function startCheckin(pool, userId, status) {
  const date = checkinDateVN();

  let flowState;
  if (status === 'fine')                                      flowState = 'monitoring';
  else if (status === 'tired' || status === 'specific_concern') flowState = 'follow_up';
  else                                                         flowState = 'high_alert';

  const nextAt = calcNextCheckin(flowState, status, 0);

  const { rows } = await pool.query(
    `INSERT INTO health_checkins
       (user_id, session_date, initial_status, current_status, flow_state,
        next_checkin_at, last_response_at, no_response_count, updated_at)
     VALUES ($1,$2,$3,$3,$4,$5,NOW(),0,NOW())
     ON CONFLICT (user_id, session_date) DO UPDATE SET
       current_status   = CASE WHEN health_checkins.flow_state = 'high_alert' AND $3 = 'fine'
                               THEN health_checkins.current_status ELSE $3 END,
       flow_state       = CASE WHEN health_checkins.flow_state = 'high_alert' AND $4 IN ('monitoring', 'follow_up')
                               THEN 'high_alert' ELSE $4 END,
       next_checkin_at  = CASE WHEN health_checkins.flow_state = 'high_alert' AND $4 IN ('monitoring', 'follow_up')
                               THEN health_checkins.next_checkin_at ELSE $5 END,
       last_response_at = NOW(),
       no_response_count= 0,
       resolved_at      = CASE WHEN $3 = 'fine' AND health_checkins.flow_state = 'monitoring'
                               THEN health_checkins.resolved_at ELSE NULL END,
       updated_at       = NOW()
     RETURNING *`,
    [userId, date, status, flowState, nextAt]
  );

  // Track engagement event
  trackEvent(pool, userId, 'checkin_response', { status, flowState }).catch(() => {});

  // Invalidate health score cache
  await cacheDel(`health:score:${userId}`);

  // Mark daily_checkin mission as completed
  updateMissionProgress(pool, userId, 'daily_checkin', 1, { goal: 1 }).catch(() => {});

  return rows[0];
}

// ─── Record follow-up response ────────────────────────────────────────────────

/**
 * User responded to a follow-up push.
 * Updates flow state and schedules next check-in.
 */
async function recordFollowUp(pool, userId, checkinId, newStatus) {
  // Get current session
  const { rows: cur } = await pool.query(
    `SELECT * FROM health_checkins WHERE id = $1 AND user_id = $2`,
    [checkinId, userId]
  );
  if (!cur.length) return null;
  const session = cur[0];

  // Already resolved — nothing to update
  if (session.flow_state === 'resolved') return session;

  let flowState = session.flow_state;
  let resolvedAt = null;

  if (newStatus === 'fine') {
    if (session.flow_state === 'monitoring') {
      // Evening confirmation after a "fine" morning → fully resolved
      flowState = 'resolved';
      resolvedAt = new Date();
    } else {
      // Recovering from tired/high_alert → back to light monitoring
      flowState = 'monitoring';
    }
  } else if (newStatus === 'very_tired' || session.flow_state === 'high_alert') {
    // Escalate or maintain high alert
    flowState = 'high_alert';
  } else {
    flowState = 'follow_up';
  }

  // Count how many follow-up responses so far (dựa trên triage_messages đã có)
  const triageMessages = session.triage_messages || [];
  const followUpCount = triageMessages.filter(m => m.role === 'user').length;

  const nextAt = calcNextCheckin(flowState, newStatus, followUpCount);

  const { rows } = await pool.query(
    `UPDATE health_checkins SET
       current_status   = $1,
       flow_state       = $2,
       next_checkin_at  = $3,
       last_response_at = NOW(),
       no_response_count = 0,
       resolved_at      = $4,
       updated_at       = NOW()
     WHERE id = $5
     RETURNING *`,
    [newStatus, flowState, nextAt, resolvedAt, checkinId]
  );

  // Track engagement event
  trackEvent(pool, userId, 'checkin_response', { newStatus, flowState, isFollowUp: true }).catch(() => {});

  return rows[0];
}

// ─── Triage ──────────────────────────────────────────────────────────────────

/**
 * Get user profile for AI context.
 */
async function getUserProfile(pool, userId) {
  const { rows } = await pool.query(
    `SELECT uop.*, u.id as uid, COALESCE(u.language_preference, 'vi') as lang
     FROM user_onboarding_profiles uop
     JOIN users u ON u.id = uop.user_id
     WHERE uop.user_id = $1`,
    [userId]
  );
  return rows[0] || {};
}

/**
 * Get recent health metrics + previous checkin summaries for AI context.
 */
async function getRecentHealthContext(pool, userId) {
  const { getSymptomFrequencyContext, getMedicationAdherenceContext } = require('./symptom-tracker.service');
  const [glucoseRes, bpRes, weightRes, checkinsRes, medRes, symptomFreqCtx, medAdherenceCtx] = await Promise.all([
    // Glucose 7 ngày gần nhất (tối đa 5 bản ghi)
    pool.query(
      `SELECT gl.value, gl.unit, gl.context, lc.occurred_at
       FROM glucose_logs gl
       JOIN logs_common lc ON lc.id = gl.log_id
       WHERE lc.user_id = $1 AND lc.occurred_at >= NOW() - INTERVAL '7 days'
       ORDER BY lc.occurred_at DESC LIMIT 5`,
      [userId]
    ),
    // Huyết áp 7 ngày gần nhất (tối đa 5 bản ghi)
    pool.query(
      `SELECT bp.systolic, bp.diastolic, bp.pulse, lc.occurred_at
       FROM blood_pressure_logs bp
       JOIN logs_common lc ON lc.id = bp.log_id
       WHERE lc.user_id = $1 AND lc.occurred_at >= NOW() - INTERVAL '7 days'
       ORDER BY lc.occurred_at DESC LIMIT 5`,
      [userId]
    ),
    // Cân nặng gần nhất
    pool.query(
      `SELECT wl.weight_kg, lc.occurred_at
       FROM weight_logs wl
       JOIN logs_common lc ON lc.id = wl.log_id
       WHERE lc.user_id = $1
       ORDER BY lc.occurred_at DESC LIMIT 1`,
      [userId]
    ),
    // 3 lần checkin gần nhất (không tính hôm nay)
    pool.query(
      `SELECT session_date, initial_status, triage_summary, triage_severity
       FROM health_checkins
       WHERE user_id = $1 AND triage_completed_at IS NOT NULL
       ORDER BY session_date DESC LIMIT 3`,
      [userId]
    ),
    // [G8] Medication log today — check if user took medication
    pool.query(
      `SELECT lc.log_type, lc.occurred_at
       FROM logs_common lc
       WHERE lc.user_id = $1 AND lc.log_type = 'medication'
         AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
       LIMIT 1`,
      [userId]
    ),
    // Symptom frequency context (from symptom_frequency table)
    getSymptomFrequencyContext(pool, userId).catch(() => null),
    // Medication adherence 7 days (from medication_adherence table)
    getMedicationAdherenceContext(pool, userId).catch(() => null),
  ]);

  return {
    recentGlucose: glucoseRes.rows,
    recentBP: bpRes.rows,
    latestWeight: weightRes.rows[0] || null,
    previousCheckins: checkinsRes.rows,
    tookMedicationToday: medRes.rows.length > 0,
    symptomFrequencyContext: symptomFreqCtx,
    medicationAdherenceContext: medAdherenceCtx,
  };
}

/**
 * Process one triage step. Returns next question or final summary.
 */
async function processTriageStep(pool, userId, checkinId, previousAnswers) {
  const { rows } = await pool.query(
    `SELECT * FROM health_checkins WHERE id = $1 AND user_id = $2`,
    [checkinId, userId]
  );
  if (!rows.length) throw new Error(t('error.session_not_found'));
  const session = rows[0];

  // Follow-up phase = triage đã hoàn thành ít nhất 1 lần (triage_completed_at đã set)
  // Nếu triage_completed_at = null → chưa bao giờ hoàn thành → vẫn là initial triage (dù có triage_messages từ lần bỏ dở)
  const isFollowUpPhase = session.triage_completed_at != null;

  const [profile, healthContext] = await Promise.all([
    getUserProfile(pool, userId),
    getRecentHealthContext(pool, userId),
  ]);

  // Hard limit: force conclusion if AI hasn't stopped in time
  const isFollowUp = isFollowUpPhase;
  const isVeryUnwell = session.initial_status === 'very_tired';
  const maxQuestions = isFollowUp ? 3 : 8;

  if (previousAnswers.length >= maxQuestions) {
    // AI đã hỏi đủ số câu → buộc kết thúc
    return {
      ok: true,
      isDone: true,
      summary: 'Đã thu thập đủ thông tin sức khoẻ.',
      severity: isVeryUnwell ? 'high' : 'medium',
      recommendation: 'Bạn hãy nghỉ ngơi và theo dõi thêm nhé. Tôi sẽ hỏi lại sau.',
      needsDoctor: false,
      needsFamilyAlert: false,
      hasRedFlag: false,
      followUpHours: calcFollowUpHours(isVeryUnwell ? 'high' : 'medium', previousAnswers.length),
    };
  }

  // ── Hard-coded red flag detection — bypass AI if user already reported danger signs ──
  const RED_FLAG_KEYWORDS = [
    'khó thở', 'đau ngực', 'tức ngực', 'hoa mắt', 'đau ngực lan',
    'vã mồ hôi', 'ngất', 'co giật', 'không thở được', 'tim đập nhanh',
    'chest pain', 'difficulty breathing', 'shortness of breath', 'fainting',
    'blurred vision', 'chest tightness',
  ];

  const _safeAns = (v) => (Array.isArray(v) ? v.join(', ') : String(v || ''));
  const allAnswerText = previousAnswers.map(a => _safeAns(a.answer).toLowerCase()).join(' ');
  const hasRedFlagInAnswers = RED_FLAG_KEYWORDS.some(kw => allAnswerText.includes(kw));

  if (hasRedFlagInAnswers) {
    const allSymptoms = previousAnswers.map(a => _safeAns(a.answer)).join(', ');
    const urgentResult = {
      ok: true,
      isDone: true,
      summary: allSymptoms,
      severity: 'high',
      recommendation: profile.lang === 'en'
        ? 'You reported serious symptoms. Please rest and see a doctor as soon as possible.'
        : 'Bạn có dấu hiệu cần chú ý. Hãy nghỉ ngơi và liên hệ bác sĩ sớm nhất có thể.',
      needsDoctor: true,
      needsFamilyAlert: true,
      hasRedFlag: true,
      followUpHours: 1,
    };

    // Save to DB
    await pool.query(
      `UPDATE health_checkins SET
         triage_summary=$1, triage_severity=$2, triage_messages=$3::jsonb,
         triage_completed_at=NOW(), next_checkin_at=$4, updated_at=NOW()
       WHERE id=$5`,
      [urgentResult.summary, urgentResult.severity, JSON.stringify(previousAnswers),
       hoursFromNow(1), checkinId]
    );

    // Alert family immediately
    if (!session.family_alerted) {
      await alertFamily(pool, session);
      await pool.query(
        `UPDATE health_checkins SET family_alerted=true, family_alerted_at=NOW() WHERE id=$1`,
        [checkinId]
      );
    }

    // #2: System reacts to AI findings
    await reactToTriageResult(pool, userId, checkinId, urgentResult);

    // #3: Extract and save symptoms for AI memory
    saveSymptomLogs(pool, userId, checkinId, previousAnswers, session.session_date).catch(() => {});

    // Invalidate health score cache so home screen updates immediately
    await cacheDel(`health:score:${userId}`);

    return urgentResult;
  }

  // For follow-up: pass previous triage Q&A so AI doesn't repeat questions
  const prevTriageMessages = isFollowUpPhase
    ? (Array.isArray(session.triage_messages) ? session.triage_messages : [])
    : [];

  let result = await getNextTriageQuestion({
    status:                  isFollowUpPhase ? (session.current_status || session.initial_status) : session.initial_status,
    phase:                   isFollowUpPhase ? 'followup' : 'initial',
    lang:                    profile.lang || 'vi',
    profile,
    healthContext,
    previousAnswers,
    previousSessionSummary:  session.triage_summary || null,
    previousTriageMessages:  prevTriageMessages,
    pool,
    userId,
  });

  // ── Double enforcement: block early isDone at service level too ──
  const minQForPhase = isFollowUp ? 2 : 5;
  // Follow-up: allow early conclusion if user says "improved" in layer 1
  const IMPROVED_KEYWORDS = ['đã đỡ', 'đỡ nhiều', 'đỡ rồi', 'hết rồi', 'ổn rồi', 'better', 'improved', 'đang đỡ'];
  const userImproved = isFollowUp && previousAnswers.some(a =>
    IMPROVED_KEYWORDS.some(kw => _safeAns(a.answer).toLowerCase().includes(kw))
  );
  console.log(`[Triage] enforcement check: isDone=${result.isDone}, answers=${previousAnswers.length}, min=${minQForPhase}, hasRedFlag=${result.hasRedFlag}, isFollowUp=${isFollowUp}, userImproved=${userImproved}`);
  if (result.isDone && previousAnswers.length < minQForPhase && !result.hasRedFlag && !userImproved) {
    console.log(`[Triage] ⛔ Service-level block: isDone at ${previousAnswers.length}/${minQForPhase}. Returning fallback.`);
    const fallbacks = [
      { q: 'Từ lúc bắt đầu đến giờ, tình trạng có thay đổi không?', opts: ['đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn'], multi: false, types: [5] },
      { q: 'Bạn nghĩ điều gì có thể dẫn đến tình trạng này?', opts: ['ngủ ít', 'bỏ bữa', 'căng thẳng', 'quên uống thuốc', 'không rõ'], multi: true, types: [7] },
      { q: 'Bạn đã làm gì để cải thiện chưa?', opts: ['nghỉ ngơi', 'ăn uống', 'uống nước', 'uống thuốc', 'chưa làm gì'], multi: true, types: [8] },
      { q: 'Mức độ khó chịu của bạn hiện tại thế nào?', opts: ['nhẹ', 'trung bình', 'khá nặng'], multi: false, types: [2] },
      { q: 'Tình trạng này có hay xảy ra không?', opts: ['lần đầu', 'thỉnh thoảng', 'hay bị', 'gần đây bị nhiều hơn'], multi: false, types: [10] },
    ];
    // Find a question whose TYPE hasn't been used
    const usedQs = new Set(previousAnswers.map(a => a.question.toLowerCase()));
    const fb = fallbacks.find(f => !usedQs.has(f.q.toLowerCase())) || fallbacks[fallbacks.length - 1];
    result = { ok: true, isDone: false, question: fb.q, options: fb.opts, multiSelect: fb.multi };
  }

  // ── Anti-loop: if AI returns a question too similar to a previous one → force conclusion ──
  // Only apply after minQuestions met (don't cut short initial interview)
  if (!result.isDone && result.question && previousAnswers.length >= minQForPhase) {
    const newQ = result.question.toLowerCase();
    const isDuplicate = previousAnswers.some(a => {
      const prevQ = a.question.toLowerCase();
      const newWords = new Set(newQ.split(/\s+/).filter(w => w.length > 2));
      const prevWords = prevQ.split(/\s+/).filter(w => w.length > 2);
      if (prevWords.length === 0) return false;
      const overlap = prevWords.filter(w => newWords.has(w)).length;
      return overlap / prevWords.length > 0.7;
    });

    if (isDuplicate) {
      const allSymptoms = previousAnswers.map(a => _safeAns(a.answer)).join(', ');
      result = {
        isDone: true,
        summary: allSymptoms,
        severity: isVeryUnwell ? 'high' : 'medium',
        recommendation: profile.lang === 'en'
          ? 'Thank you for sharing. Please rest and take care.'
          : 'Cảm ơn bạn đã chia sẻ. Hãy nghỉ ngơi và theo dõi thêm nhé.',
        needsDoctor: false,
        needsFamilyAlert: false,
        hasRedFlag: false,
        followUpHours: calcFollowUpHours(isVeryUnwell ? 'high' : 'medium', previousAnswers.length),
      };
    }
  }

  // ── Illusion Layer: enhance response with continuity/empathy/progress ──
  try {
    const illusionCtx = await buildCheckinContext(pool, userId);
    const lastAnswer = previousAnswers.length > 0 ? previousAnswers[previousAnswers.length - 1] : null;
    const illusionUser = { id: userId, ...profile, lang: profile.lang || 'vi' };

    if (result.isDone) {
      // Conclusion: add progress feedback
      const enhanced = applyIllusion(
        { isDone: true, conclusion: { severity: result.severity }, currentStep: previousAnswers.length, totalSteps: previousAnswers.length },
        {}, illusionCtx, illusionUser, {}
      );
      if (enhanced._progress) result._progress = enhanced._progress;
    } else if (result.question) {
      // Question: add empathy + continuity
      const enhanced = applyIllusion(
        { isDone: false, question: { id: `q${previousAnswers.length}`, text: result.question, type: 'single_choice' }, currentStep: previousAnswers.length, totalSteps: 8 },
        { greeting: null }, illusionCtx, illusionUser, { lastAnswer }
      );
      if (enhanced._empathy) result._empathy = enhanced._empathy;
      if (enhanced._continuity) result._continuity = enhanced._continuity;
      if (enhanced._greeting) result._greeting = enhanced._greeting;
    }
  } catch (err) {
    console.warn('[Illusion] Failed in triage, using original:', err.message);
  }

  // Save latest triage messages
  await pool.query(
    `UPDATE health_checkins SET
       triage_messages = $1::jsonb,
       updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(previousAnswers), checkinId]
  );

  // If AI says done, save summary + update next check-in time
  if (result.isDone) {
    const followUpHours = result.followUpHours || calcFollowUpHours(result.severity || 'medium');
    const nextAt = hoursFromNow(followUpHours);

    await pool.query(
      `UPDATE health_checkins SET
         triage_summary       = $1,
         triage_severity      = $2,
         triage_messages      = $3::jsonb,
         triage_completed_at  = NOW(),
         next_checkin_at      = $4,
         updated_at           = NOW()
       WHERE id = $5`,
      [result.summary, result.severity, JSON.stringify(previousAnswers), nextAt, checkinId]
    );

    // AI đánh giá cần cảnh báo gia đình ngay → alert luôn không chờ no-response
    if (result.needsFamilyAlert && !session.family_alerted) {
      await alertFamily(pool, session);
      await pool.query(
        `UPDATE health_checkins SET family_alerted=true, family_alerted_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [checkinId]
      );

      // Thông báo in-app cho chính user biết gia đình đã được nhắn
      const userLang = profile.lang || 'vi';
      await sendCheckinNotification(
        pool, userId, null,
        'caregiver_alert',
        t('checkin.family_notified_title', userLang),
        t('checkin.family_notified_body', userLang),
        { checkinId: String(checkinId) }
      );
    }

    // #2: System reacts to AI findings
    await reactToTriageResult(pool, userId, checkinId, result);

    // #3: Extract and save symptoms for AI memory
    saveSymptomLogs(pool, userId, checkinId, previousAnswers, session.session_date).catch(() => {});

    // Invalidate health score cache so home screen updates immediately
    await cacheDel(`health:score:${userId}`);
  }

  return result;
}

// ─── #2: System reacts to AI triage findings ─────────────────────────────────

/**
 * After triage completes, adjust session state and notifications based on severity.
 * - high   → flow_state='high_alert', next check-in in 1h
 * - medium → ensure follow-up in 3-4h
 * - needsDoctor → high-priority notification to user
 */
async function reactToTriageResult(pool, userId, checkinId, result) {
  const severity = result.severity || 'low';

  try {
    if (severity === 'high') {
      // Escalate: set high_alert, reduce next check-in to 1h
      await pool.query(
        `UPDATE health_checkins SET
           flow_state      = 'high_alert',
           current_status  = COALESCE($1, current_status),
           next_checkin_at = $2,
           updated_at      = NOW()
         WHERE id = $3`,
        [severity === 'high' ? 'very_tired' : null, hoursFromNow(1), checkinId]
      );
    } else if (severity === 'medium') {
      // Ensure follow-up in 3-4h
      const followUpHours = result.followUpHours || 3;
      await pool.query(
        `UPDATE health_checkins SET
           flow_state      = CASE WHEN flow_state = 'monitoring' THEN 'follow_up' ELSE flow_state END,
           current_status  = COALESCE(current_status, 'tired'),
           next_checkin_at = LEAST(next_checkin_at, $1),
           updated_at      = NOW()
         WHERE id = $2`,
        [hoursFromNow(followUpHours), checkinId]
      );
    }
    // For 'low' severity — no additional state changes needed

    // If AI recommends seeing a doctor, send high-priority notification
    if (result.needsDoctor) {
      // Get user lang
      const { rows: langRows } = await pool.query(
        `SELECT COALESCE(language_preference,'vi') AS lang FROM users WHERE id=$1`,
        [userId]
      );
      const lang = langRows[0]?.lang || 'vi';
      const title = lang === 'en' ? 'Doctor visit recommended' : 'Khuyến nghị khám bác sĩ';
      const body = lang === 'en'
        ? 'Based on your symptoms, you should see a doctor as soon as possible.'
        : 'Bạn nên đi khám bác sĩ dựa trên các triệu chứng bạn mô tả.';

      await dispatchNotification(pool, {
        userId,
        type: 'health_alert',
        title,
        body,
        data: { checkinId: String(checkinId), severity, needsDoctor: true },
        priority: 'high',
      });
    }

    // Update current_status based on severity progression
    const statusBySeverity = { high: 'very_tired', medium: 'tired', low: 'fine' };
    const newStatus = statusBySeverity[severity];
    if (newStatus) {
      await pool.query(
        `UPDATE health_checkins SET
           current_status = CASE
             WHEN $1 = 'very_tired' THEN 'very_tired'
             WHEN $1 = 'tired' AND current_status NOT IN ('very_tired') THEN 'tired'
             ELSE current_status
           END,
           updated_at = NOW()
         WHERE id = $2`,
        [newStatus, checkinId]
      );
    }
  } catch (err) {
    console.error('[reactToTriageResult] Error reacting to triage:', err.message);
    // Non-fatal: don't break triage flow if reaction fails
  }
}

// ─── Emergency ───────────────────────────────────────────────────────────────

/**
 * User pressed emergency button.
 * Alerts ALL care circle members with can_receive_alerts=true.
 */
async function triggerEmergency(pool, userId, location) {
  console.log(`[SOS] triggerEmergency userId=${userId} location=${JSON.stringify(location)}`);

  // Mark session
  const { rows: sessionRows } = await pool.query(
    `INSERT INTO health_checkins
       (user_id, session_date, initial_status, current_status, flow_state,
        emergency_triggered, emergency_location, resolved_at, updated_at)
     VALUES ($1,$2,'very_tired','very_tired','high_alert',true,$3::jsonb,NULL,NOW())
     ON CONFLICT (user_id, session_date) DO UPDATE SET
       emergency_triggered = true,
       emergency_location  = $3::jsonb,
       flow_state          = 'high_alert',
       updated_at          = NOW()
     RETURNING id`,
    [userId, checkinDateVN(), JSON.stringify(location || null)]
  );
  const checkinId = sessionRows[0]?.id;
  console.log(`[SOS] checkin upserted id=${checkinId}`);

  // Get user info
  const { rows: userRows } = await pool.query(
    `SELECT u.display_name, u.full_name, u.phone_number,
            COALESCE(u.language_preference,'vi') as lang
     FROM users u WHERE u.id = $1`,
    [userId]
  );
  const user = userRows[0] || {};
  const lang = user.lang || 'vi';
  const fullName = user.display_name || user.full_name || t('careCircle.user_label', lang);
  const userName = getShortName(fullName) || fullName;

  // Get care circle members who can receive alerts (both directions)
  // relationship_type: vai trò của addressee với requester (VD: requester='con', addressee='Bố')
  // → nếu patient là requester, caregiver (addressee) thấy patient là "con" (reverse)
  // → nếu patient là addressee, caregiver (requester) thấy patient theo relationship_type
  const { rows: caregivers } = await pool.query(
    `SELECT u.id, u.push_token,
            COALESCE(u.language_preference, 'vi') as lang,
            uc.permissions->>'can_receive_alerts' as can_receive_alerts,
            uc.status,
            uc.relationship_type,
            CASE WHEN uc.requester_id = $1 THEN 'requester' ELSE 'addressee' END as patient_side
     FROM user_connections uc
     JOIN users u ON u.id = CASE
       WHEN uc.requester_id = $1 THEN uc.addressee_id
       ELSE uc.requester_id
     END
     WHERE (uc.requester_id = $1 OR uc.addressee_id = $1)
       AND uc.status = 'accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean, false) = true`,
    [userId]
  );
  console.log(`[SOS] found ${caregivers.length} caregiver(s):`, caregivers.map(c => ({ id: c.id, hasToken: !!c.push_token, can_receive_alerts: c.can_receive_alerts })));

  const locationStr = location
    ? ` (${location.lat?.toFixed(4)}, ${location.lng?.toFixed(4)})`
    : '';
  const data = { type: 'emergency', userId: String(userId), location, patientPhone: user.phone_number || '' };

  for (const cg of caregivers) {
    const cgLang = cg.lang || 'vi';
    // Title/body đều bắt đầu bằng {{name}} → viết hoa
    const patientDisplay = cg.patient_side === 'requester'
      ? getPatientRoleForCaregiver(cg.relationship_type, userName, cgLang, true)
      : userName;
    const title = t('checkin.emergency_title', cgLang, { name: patientDisplay });
    const body  = t('checkin.emergency_body', cgLang, { name: patientDisplay, location: locationStr });
    // Insert confirmation record so caregiver sees pending alert
    if (checkinId) {
      try {
        await pool.query(
          `INSERT INTO caregiver_alert_confirmations
             (checkin_id, caregiver_id, patient_id, alert_type, sent_at, resent_count)
           VALUES ($1,$2,$3,'emergency',NOW(),0)
           ON CONFLICT (checkin_id, caregiver_id) DO UPDATE SET
             alert_type = 'emergency', sent_at = NOW(), confirmed_at = NULL, resent_count = 0`,
          [checkinId, cg.id, userId]
        );
        console.log(`[SOS] inserted caregiver_alert_confirmations for caregiver=${cg.id}`);
      } catch (e) {
        console.error(`[SOS] failed to insert confirmation for caregiver=${cg.id}:`, e.message);
      }
    }

    console.log(`[SOS] sending notification to caregiver=${cg.id} pushToken=${cg.push_token ? cg.push_token.slice(0,30) + '...' : 'NONE'}`);
    const result = await sendCheckinNotification(
      pool, cg.id, cg.push_token || null,
      'emergency', title, body, data
    );
    console.log(`[SOS] notification sent to caregiver=${cg.id}`, result);
  }

  return {
    ok: true,
    caregiversAlerted: caregivers.length,
    message: caregivers.length
      ? t('checkin.emergency_alerted', lang, { count: caregivers.length })
      : t('checkin.emergency_no_caregivers', lang),
  };
}

// ─── Smart family alert logic ─────────────────────────────────────────────────

/**
 * Determine whether family should be alerted based on user history,
 * age, time of day, and severity — instead of a simple miss count check.
 */
async function shouldAlertFamily(pool, userId, session) {
  // 1. Check user response history (last 7 days)
  const historyRes = await pool.query(
    `SELECT no_response_count, initial_status, triage_severity, created_at
     FROM health_checkins
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC LIMIT 7`,
    [userId]
  );

  const history = historyRes.rows;
  const avgNoResponse = history.length > 0
    ? history.reduce((sum, h) => sum + (h.no_response_count || 0), 0) / history.length
    : 0;

  // 2. Check user age (elderly = more urgent)
  const profileRes = await pool.query(
    `SELECT birth_year FROM user_onboarding_profiles WHERE user_id = $1`,
    [userId]
  );
  const age = profileRes.rows[0]?.birth_year
    ? new Date().getFullYear() - profileRes.rows[0].birth_year
    : null;
  const isElderly = age && age >= 65;

  // 3. Check time of day (night = more concerning)
  const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false }), 10);
  const isNightTime = hour >= 22 || hour < 6;

  // 4. Check latest severity
  const isHighSeverity = session.triage_severity === 'high' || session.flow_state === 'high_alert';

  // Decision logic:
  // - High severity → always alert
  // - Elderly + no response → alert after 1 miss
  // - Night time + no response → alert after 1 miss
  // - Normal user who often doesn't respond (avg > 1) → wait longer (3 misses)
  // - Normal user → alert after 2 misses

  const noResponseCount = session.no_response_count || 0;

  if (isHighSeverity) return { shouldAlert: true, reason: 'high_severity' };
  if (isElderly && noResponseCount >= 1) return { shouldAlert: true, reason: 'elderly_no_response' };
  if (isNightTime && noResponseCount >= 1) return { shouldAlert: true, reason: 'nighttime_no_response' };
  if (avgNoResponse > 1 && noResponseCount >= 3) return { shouldAlert: true, reason: 'habitual_non_responder_exceeded' };
  if (noResponseCount >= 2) return { shouldAlert: true, reason: 'no_response_threshold' };

  return { shouldAlert: false, reason: 'within_tolerance' };
}

// ─── No-response escalation (called by cron) ─────────────────────────────────

/**
 * Check all active sessions where next_checkin_at has passed.
 * Send follow-up push or escalate to family alert.
 */
async function runCheckinFollowUps(pool) {
  const now = new Date();

  // Atomically claim overdue sessions by pushing next_checkin_at forward,
  // preventing concurrent cron ticks from picking up the same session
  const { rows: overdue } = await pool.query(
    `UPDATE health_checkins
     SET next_checkin_at = NOW() + INTERVAL '2 hours', updated_at = NOW()
     FROM users u
     WHERE u.id = health_checkins.user_id
       AND u.deleted_at IS NULL
       AND health_checkins.next_checkin_at <= $1
       AND health_checkins.resolved_at IS NULL
       AND health_checkins.session_date = $2
       AND health_checkins.flow_state != 'resolved'
     RETURNING health_checkins.*, u.push_token, u.display_name, u.full_name,
               COALESCE(u.language_preference,'vi') as lang,
               (SELECT uop.risk_score FROM user_onboarding_profiles uop WHERE uop.user_id = u.id) as risk_score,
               (SELECT uop.birth_year FROM user_onboarding_profiles uop WHERE uop.user_id = u.id) as birth_year,
               (SELECT uop.gender FROM user_onboarding_profiles uop WHERE uop.user_id = u.id) as gender`,
    [now, checkinDateVN()]
  );

  let sent = 0;
  let escalated = 0;

  for (const session of overdue) {
    const newMissCount = session.no_response_count + 1;

    if (newMissCount === 1) {
      // First miss → push + in-app nhắc
      const sLang = session.lang || 'vi';
      const h = getHonorifics(session);
      const hParams = { honorific: h.honorific, selfRef: h.selfRef, callName: h.callName, Honorific: h.Honorific };
      const msg = session.flow_state === 'high_alert'
        ? t('checkin.followup_high_alert', sLang, hParams)
        : t('checkin.followup_normal', sLang, hParams);

      await sendCheckinNotification(
        pool, session.user_id, session.push_token,
        'checkin_followup',
        t('checkin.followup_title', sLang, hParams),
        msg,
        { checkinId: String(session.id) }
      );
      sent++;

      // Schedule next check — same interval as before
      const nextAt = session.flow_state === 'high_alert' ? hoursFromNow(2) : hoursFromNow(4);
      await pool.query(
        `UPDATE health_checkins SET no_response_count=$1, next_checkin_at=$2, updated_at=NOW() WHERE id=$3`,
        [newMissCount, nextAt, session.id]
      );
    } else {
      // 2+ misses: use smart alert logic to decide whether to alert family
      const updatedSession = { ...session, no_response_count: newMissCount };
      const alertDecision = await shouldAlertFamily(pool, session.user_id, updatedSession);
      const doAlert = alertDecision.shouldAlert && !session.family_alerted;

      if (doAlert) {
        await alertFamily(pool, session);
        escalated++;
        console.log(`[runCheckinFollowUps] Smart alert triggered for user ${session.user_id}: ${alertDecision.reason}`);
      }

      // Still push + in-app user one more time
      const sLang2 = session.lang || 'vi';
      const h2 = getHonorifics(session);
      const hParams2 = { honorific: h2.honorific, selfRef: h2.selfRef, callName: h2.callName, Honorific: h2.Honorific, name: getShortName(session.display_name || session.full_name) || '' };
      await sendCheckinNotification(
        pool, session.user_id, session.push_token,
        'checkin_followup_urgent',
        t('checkin.no_response_title', sLang2, hParams2),
        t('checkin.no_response_body', sLang2, hParams2),
        { checkinId: String(session.id) }
      );
      sent++;

      // If miss count exceeds 4, mark resolved to stop spamming
      if (newMissCount >= 4) {
        await pool.query(
          `UPDATE health_checkins SET no_response_count=$1, family_alerted=$2,
             family_alerted_at=CASE WHEN $2 THEN NOW() ELSE family_alerted_at END,
             resolved_at=NOW(), updated_at=NOW() WHERE id=$3`,
          [newMissCount, doAlert, session.id]
        );
      } else {
        const nextAt = session.flow_state === 'high_alert' ? hoursFromNow(2) : hoursFromNow(4);
        await pool.query(
          `UPDATE health_checkins SET no_response_count=$1, family_alerted=$2,
             family_alerted_at=CASE WHEN $2 THEN NOW() ELSE family_alerted_at END,
             next_checkin_at=$3, updated_at=NOW() WHERE id=$4`,
          [newMissCount, doAlert, nextAt, session.id]
        );
      }
    }
  }

  return { total: overdue.length, sent, escalated };
}

/** Alert all eligible care circle members about user's non-response */
async function alertFamily(pool, session, alertType = 'caregiver_alert') {
  const { rows: userRows } = await pool.query(
    `SELECT display_name, full_name, phone_number, COALESCE(language_preference,'vi') AS lang FROM users WHERE id=$1`,
    [session.user_id]
  );
  const user = userRows[0] || {};
  const aLang = user.lang || 'vi';
  const fullN = user.display_name || user.full_name || t('brain.relative_label', aLang);
  const name = getShortName(fullN) || fullN;

  const { rows: caregivers } = await pool.query(
    `SELECT u.id, u.push_token,
            COALESCE(u.language_preference, 'vi') as lang,
            uc.relationship_type,
            CASE WHEN uc.requester_id = $1 THEN 'requester' ELSE 'addressee' END as patient_side
     FROM user_connections uc
     JOIN users u ON u.id = CASE
       WHEN uc.requester_id = $1 THEN uc.addressee_id
       ELSE uc.requester_id
     END
     WHERE (uc.requester_id = $1 OR uc.addressee_id = $1)
       AND uc.status = 'accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean,false) = true`,
    [session.user_id]
  );

  if (!caregivers.length) return;

  for (const cg of caregivers) {
    const cgLang = cg.lang || 'vi';
    const patientDisplay = cg.patient_side === 'requester'
      ? getPatientRoleForCaregiver(cg.relationship_type, name, cgLang, true)
      : name;
    const title = alertType === 'emergency'
      ? t('checkin.emergency_title', cgLang, { name: patientDisplay })
      : t('checkin.health_check_needed_title', cgLang);
    const body = alertType === 'emergency'
      ? t('checkin.emergency_family_body', cgLang, { name: patientDisplay })
      : t('checkin.no_response_family_body', cgLang, { name: patientDisplay });

    // Upsert confirmation record (skip if already confirmed)
    const { rows: existing } = await pool.query(
      `SELECT id, confirmed_at FROM caregiver_alert_confirmations
       WHERE checkin_id=$1 AND caregiver_id=$2`,
      [session.id, cg.id]
    );
    if (existing.length && existing[0].confirmed_at) continue; // đã xác nhận rồi, không gửi lại

    let alertId;
    if (!existing.length) {
      const { rows: ins } = await pool.query(
        `INSERT INTO caregiver_alert_confirmations
           (checkin_id, caregiver_id, patient_id, alert_type)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [session.id, cg.id, session.user_id, alertType]
      );
      alertId = ins[0].id;
    } else {
      alertId = existing[0].id;
      await pool.query(
        `UPDATE caregiver_alert_confirmations
         SET resent_count=resent_count+1, resent_at=NOW() WHERE id=$1`,
        [alertId]
      );
    }

    await sendCheckinNotification(
      pool, cg.id, cg.push_token || null,
      alertType, title, body,
      { alertId: String(alertId), patientId: String(session.user_id), checkinId: String(session.id), patientPhone: user.phone_number || '' }
    );
  }
}

// ─── Caregiver alert confirmation ────────────────────────────────────────────

/**
 * Caregiver xác nhận đã đọc alert.
 * @param {number} caregiverId
 * @param {number} alertId
 * @param {'seen'|'on_my_way'|'called'} action
 */
async function confirmCaregiverAlert(pool, caregiverId, alertId, action) {
  // 1. SELECT the alert first to get patient_id before updating
  const { rows: alertRows } = await pool.query(
    `SELECT cac.*, (SELECT user_id FROM health_checkins WHERE id=cac.checkin_id) AS patient_id
     FROM caregiver_alert_confirmations cac
     WHERE cac.id=$1 AND cac.caregiver_id=$2 AND cac.confirmed_at IS NULL`,
    [alertId, caregiverId]
  );
  if (!alertRows.length) return { ok: false, error: t('careCircle.alert_not_found_or_confirmed') };

  const alert = alertRows[0];

  // 2. Check can_ack_escalation permission
  const { rows: permRows } = await pool.query(
    `SELECT id FROM user_connections
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
       AND COALESCE((permissions->>'can_ack_escalation')::boolean, false) = true`,
    [alert.patient_id, caregiverId]
  );
  if (permRows.length === 0) {
    return { ok: false, error: t('careCircle.no_permission') };
  }

  // 3. Now UPDATE to confirm the alert
  await pool.query(
    `UPDATE caregiver_alert_confirmations
     SET confirmed_at=NOW(), confirmed_action=$1
     WHERE id=$2 AND caregiver_id=$3 AND confirmed_at IS NULL`,
    [action, alertId, caregiverId]
  );

  // Thông báo in-app cho user bệnh biết người thân đã xác nhận
  const { rows: cgRows } = await pool.query(
    `SELECT display_name, full_name FROM users WHERE id=$1`, [caregiverId]
  );
  // Get patient lang for notification
  const { rows: patientRows } = await pool.query(
    `SELECT COALESCE(language_preference,'vi') AS lang FROM users WHERE id=$1`,
    [alert.patient_id]
  );
  const pLang = patientRows[0]?.lang || 'vi';
  const cgFullName = cgRows[0]?.display_name || cgRows[0]?.full_name || t('brain.relative_fallback', pLang);
  const cgName = getShortName(cgFullName) || cgFullName;
  const actionKey = action === 'on_my_way' ? 'checkin.action_on_my_way'
    : action === 'called' ? 'checkin.action_called' : 'checkin.action_seen';
  const actionLabel = t(actionKey, pLang);

  await sendCheckinNotification(
    pool, alert.patient_id, null,
    'caregiver_confirmed',
    `${cgName} ${actionLabel}`,
    t('checkin.caregiver_confirmed_body', pLang, { name: cgName, action: actionLabel }),
    { alertId: String(alertId), caregiverId: String(caregiverId) }
  );

  return { ok: true };
}

/**
 * Lấy danh sách alerts chưa xác nhận dành cho caregiver hiện tại.
 */
async function getPendingCaregiverAlerts(pool, caregiverId) {
  const { rows } = await pool.query(
    `SELECT cac.id as alert_id, cac.alert_type, cac.sent_at, cac.checkin_id,
            u.display_name, u.full_name,
            hc.current_status, hc.flow_state
     FROM caregiver_alert_confirmations cac
     JOIN users u ON u.id = cac.patient_id
     JOIN health_checkins hc ON hc.id = cac.checkin_id
     WHERE cac.caregiver_id=$1
       AND cac.confirmed_at IS NULL
     ORDER BY cac.sent_at DESC`,
    [caregiverId]
  );
  return rows.map(r => ({
    alertId:       r.alert_id,
    alertType:     r.alert_type,
    sentAt:        r.sent_at,
    checkinId:     r.checkin_id,
    patientName:   getShortName(r.display_name || r.full_name) || r.display_name || r.full_name || t('brain.relative_fallback'),
    currentStatus: r.current_status,
    flowState:     r.flow_state,
  }));
}

/**
 * Cron: gửi lại alert sau 30 phút nếu chưa xác nhận (tối đa 1 lần)
 */
async function runAlertConfirmationFollowUps(pool) {
  // Re-alert every 30 minutes until caregiver confirms, up to MAX_RESENDS times
  const MAX_RESENDS = 4; // max 4 re-alerts (= 2 hours total after initial)
  const RESEND_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  // Find unconfirmed alerts where last send was >= 30 min ago and haven't hit max
  const cutoff = new Date(Date.now() - RESEND_INTERVAL_MS);
  const { rows } = await pool.query(
    `SELECT cac.*, u.push_token,
            COALESCE(u.language_preference, 'vi') AS cg_lang,
            p.display_name AS patient_name, p.full_name AS patient_full_name,
            uc.relationship_type,
            CASE WHEN uc.requester_id = cac.patient_id THEN 'requester' ELSE 'addressee' END as patient_side
     FROM caregiver_alert_confirmations cac
     JOIN users u ON u.id = cac.caregiver_id
     JOIN users p ON p.id = cac.patient_id
     LEFT JOIN user_connections uc ON
       (uc.requester_id = cac.patient_id AND uc.addressee_id = cac.caregiver_id)
       OR (uc.requester_id = cac.caregiver_id AND uc.addressee_id = cac.patient_id)
     WHERE cac.confirmed_at IS NULL
       AND cac.resent_count < $1
       AND COALESCE(cac.resent_at, cac.sent_at) <= $2`,
    [MAX_RESENDS, cutoff]
  );

  for (const alert of rows) {
    // Skip if alertFamily already sent a caregiver_alert to this caregiver within the resend interval
    const { rows: recentNotif } = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'caregiver_alert' AND created_at >= $2 LIMIT 1`,
      [alert.caregiver_id, cutoff]
    );
    if (recentNotif.length > 0) continue;

    const cgLang = alert.cg_lang || 'vi';
    const patientFullName = alert.patient_name || alert.patient_full_name || t('brain.relative_fallback', cgLang);
    const patientName = getShortName(patientFullName) || patientFullName;
    const patientDisplay = alert.patient_side === 'requester'
      ? getPatientRoleForCaregiver(alert.relationship_type, patientName, cgLang, true)
      : patientName;
    const resendNum = alert.resent_count + 1;
    const title = alert.alert_type === 'emergency'
      ? t('checkin.reminder_emergency_title', cgLang)
      : t('checkin.reminder_health_check_title', cgLang);
    const body = t('checkin.reminder_confirm_body', cgLang, { name: patientDisplay });

    await sendCheckinNotification(
      pool, alert.caregiver_id, alert.push_token || null,
      alert.alert_type, title, body,
      { alertId: String(alert.id), patientId: String(alert.patient_id), checkinId: String(alert.checkin_id) }
    );
    await pool.query(
      `UPDATE caregiver_alert_confirmations SET resent_count=$1, resent_at=NOW() WHERE id=$2`,
      [resendNum, alert.id]
    );
  }
  return { resent: rows.length };
}

// ─── Morning check-in notification (7am cron) ────────────────────────────────

/**
 * Send morning health check-in push to all users who haven't checked in today.
 * Called by basic.notification.service at hour=7.
 */
async function runMorningCheckin(pool, hour) {
  if (hour !== 7) return { type: 'morning_checkin', total: 0, sent: 0 };

  const { rows } = await pool.query(
    `SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang,
            u.display_name, u.full_name, uop.birth_year, uop.gender
     FROM users u
     JOIN user_onboarding_profiles uop ON uop.user_id = u.id
     LEFT JOIN user_notification_preferences np ON np.user_id = u.id
     WHERE u.push_token IS NOT NULL
       AND u.deleted_at IS NULL
       AND uop.onboarding_completed_at IS NOT NULL
       AND COALESCE(np.reminders_enabled, true) = true
       AND NOT EXISTS (
         SELECT 1 FROM health_checkins hc
         WHERE hc.user_id = u.id AND hc.session_date = $1
       )
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id = u.id AND n.type = 'morning_checkin'
           AND DATE(n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
       )`,
    [checkinDateVN()]
  );

  let sent = 0;
  for (const user of rows) {
    const h = getHonorifics(user);
    const hParams = { honorific: h.honorific, selfRef: h.selfRef, callName: h.callName, Honorific: h.Honorific };
    await sendCheckinNotification(
      pool, user.id, user.push_token,
      'morning_checkin',
      t('checkin.morning_title', user.lang, hParams),
      t('checkin.morning_body', user.lang, hParams),
      { type: 'morning_checkin' }
    );
    sent++;
  }

  return { type: 'morning_checkin', total: rows.length, sent };
}

// ─── Health Report ──────────────────────────────────────────────────────────

/**
 * Tạo báo cáo sức khoẻ tuần/tháng từ lịch sử check-in.
 * @param {object} pool
 * @param {number} userId
 * @param {number} days - 7 (tuần) hoặc 30 (tháng)
 */
async function getHealthReport(pool, userId, days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  // Lấy tất cả sessions trong khoảng thời gian
  const { rows: sessions } = await pool.query(
    `SELECT id, session_date, initial_status, current_status, flow_state,
            triage_summary, triage_severity, triage_messages,
            resolved_at, family_alerted, emergency_triggered,
            created_at
     FROM health_checkins
     WHERE user_id = $1 AND session_date >= $2
     ORDER BY session_date DESC`,
    [userId, sinceStr]
  );

  if (!sessions.length) {
    return {
      totalDays: days,
      checkinDays: 0,
      sessions: [],
      severityDistribution: { low: 0, medium: 0, high: 0 },
      statusDistribution: { fine: 0, tired: 0, very_tired: 0, specific_concern: 0 },
      commonSymptoms: [],
      alerts: { familyAlerted: 0, emergencyTriggered: 0 },
      trend: 'stable',
      highlights: [],
    };
  }

  // Phân bố severity
  const severityDist = { low: 0, medium: 0, high: 0 };
  const statusDist = { fine: 0, tired: 0, very_tired: 0, specific_concern: 0 };
  let familyAlerted = 0;
  let emergencyTriggered = 0;
  const symptomMap = {};

  for (const s of sessions) {
    if (s.triage_severity && severityDist[s.triage_severity] !== undefined) {
      severityDist[s.triage_severity]++;
    }
    if (s.initial_status && statusDist[s.initial_status] !== undefined) {
      statusDist[s.initial_status]++;
    }
    if (s.family_alerted) familyAlerted++;
    if (s.emergency_triggered) emergencyTriggered++;

    // Trích xuất triệu chứng từ triage_messages (chỉ giữ triệu chứng thực sự)
    const NON_SYMPTOM_ANSWERS = new Set([
      // Severity responses
      'nhẹ', 'trung bình', 'khá nặng', 'rất nặng',
      'mild', 'moderate', 'quite severe', 'very severe',
      // Time responses
      'vừa mới', 'vài giờ trước', 'từ sáng', 'từ hôm qua', 'vài tiếng trước',
      'just now', 'a few hours ago', 'since morning', 'since yesterday',
      // Status responses
      'đã đỡ', 'vẫn vậy', 'mệt hơn', 'đã đỡ hơn', 'vẫn như cũ', 'mệt hơn trước',
      'vẫn như lúc đầu', 'có vẻ nặng hơn', 'đang đỡ dần', 'vẫn giống lúc đầu',
      'better', 'about the same', 'worse', 'getting better', 'getting worse',
      // Selection responses
      'không có gì thêm', 'không có triệu chứng mới', 'không thêm gì',
      // Action responses
      'nghỉ ngơi', 'ăn uống', 'uống nước', 'uống thuốc', 'chưa làm gì',
      'đã nghỉ ngơi', 'đã ăn uống', 'đã uống thuốc',
      // Cause responses
      'ngủ ít', 'bỏ bữa', 'căng thẳng', 'quên uống thuốc', 'không rõ',
      // Generic / yes-no
      'có', 'không', 'ổn', 'ok', 'đúng', 'rồi', 'chưa',
      'không có', 'không có gì thêm', 'nothing new', 'nothing yet',
    ]);
    const msgs = Array.isArray(s.triage_messages) ? s.triage_messages : [];
    for (const m of msgs) {
      if (m.answer) {
        const answer = m.answer.toLowerCase().trim();
        if (answer.length > 1 && answer.length < 50 && !NON_SYMPTOM_ANSWERS.has(answer)) {
          symptomMap[answer] = (symptomMap[answer] || 0) + 1;
        }
      }
    }
  }

  // Top triệu chứng
  const commonSymptoms = Object.entries(symptomMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([symptom, count]) => ({ symptom, count }));

  // Xu hướng: so sánh nửa đầu vs nửa sau
  const half = Math.ceil(sessions.length / 2);
  const recentHalf = sessions.slice(0, half);
  const olderHalf = sessions.slice(half);
  const severityScore = { low: 1, medium: 2, high: 3 };
  const avgRecent = recentHalf.reduce((s, r) => s + (severityScore[r.triage_severity] || 1), 0) / (recentHalf.length || 1);
  const avgOlder = olderHalf.length
    ? olderHalf.reduce((s, r) => s + (severityScore[r.triage_severity] || 1), 0) / olderHalf.length
    : avgRecent;

  let trend = 'stable';
  if (avgRecent < avgOlder - 0.3) trend = 'improving';
  else if (avgRecent > avgOlder + 0.3) trend = 'worsening';

  // Highlights
  const highlights = [];
  const checkinDays = new Set(sessions.map(s => s.session_date)).size;
  highlights.push({ type: 'consistency', value: `${checkinDays}/${days}` });
  if (severityDist.high > 0) highlights.push({ type: 'high_severity_days', value: severityDist.high });
  if (trend === 'improving') highlights.push({ type: 'trend', value: 'improving' });
  if (trend === 'worsening') highlights.push({ type: 'trend', value: 'worsening' });

  // Session summaries cho UI
  const sessionSummaries = sessions.map(s => ({
    date: s.session_date,
    status: s.initial_status,
    severity: s.triage_severity,
    summary: s.triage_summary,
    flowState: s.flow_state,
    resolved: !!s.resolved_at,
  }));

  // Engagement stats (habit report)
  const engagementRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE no_response_count = 0) as responded,
       COUNT(*) as total,
       AVG(EXTRACT(HOUR FROM created_at)) as avg_checkin_hour
     FROM health_checkins
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'`,
    [userId]
  );

  const engagement = engagementRes.rows[0];
  const responseRate = engagement.total > 0
    ? Math.round((engagement.responded / engagement.total) * 100)
    : 0;

  return {
    totalDays: days,
    checkinDays,
    sessions: sessionSummaries,
    severityDistribution: severityDist,
    statusDistribution: statusDist,
    commonSymptoms,
    alerts: { familyAlerted, emergencyTriggered },
    trend,
    highlights,
    responseRate,
    avgCheckinHour: Math.round(engagement.avg_checkin_hour || 8),
  };
}

// ─── Health Score ────────────────────────────────────────────────────────────

/**
 * Compute a unified health score for the home screen.
 * @param {object} pool
 * @param {number} userId
 * @returns {{ level: 'ok'|'monitor'|'danger', factors: string[], checkinDone: boolean }}
 */
async function getHealthScore(pool, userId) {
  // Try cache first (TTL 3 min)
  const cached = await cacheGet(`health:score:${userId}`);
  if (cached) return cached;

  const today = checkinDateVN();
  const factors = [];

  // 1. Today's check-in
  const { rows: checkinRows } = await pool.query(
    `SELECT initial_status, triage_severity, emergency_triggered, flow_state, triage_completed_at
     FROM health_checkins WHERE user_id = $1 AND session_date = $2`,
    [userId, today]
  );
  const checkin = checkinRows[0] || null;
  // Check-in is "done" if:
  // - status is "fine" (no triage needed), OR
  // - triage completed, OR
  // - flow_state is "monitoring" or "resolved" (backend already processed)
  const checkinDone = checkin !== null && (
    checkin.initial_status === 'fine'
    || checkin.triage_completed_at !== null
    || checkin.flow_state === 'monitoring'
    || checkin.flow_state === 'resolved'
  );

  // 2. Latest glucose (last 24h)
  const { rows: glucoseRows } = await pool.query(
    `SELECT gl.value
     FROM glucose_logs gl
     JOIN logs_common lc ON lc.id = gl.log_id
     WHERE lc.user_id = $1 AND lc.occurred_at >= NOW() - INTERVAL '24 hours'
     ORDER BY lc.occurred_at DESC LIMIT 1`,
    [userId]
  );
  const glucose = glucoseRows[0]?.value ?? null;

  // 3. Latest BP (last 24h)
  const { rows: bpRows } = await pool.query(
    `SELECT bp.systolic
     FROM blood_pressure_logs bp
     JOIN logs_common lc ON lc.id = bp.log_id
     WHERE lc.user_id = $1 AND lc.occurred_at >= NOW() - INTERVAL '24 hours'
     ORDER BY lc.occurred_at DESC LIMIT 1`,
    [userId]
  );
  const systolic = bpRows[0]?.systolic ?? null;

  // 4. Compute level
  let level = 'ok';

  // Danger conditions
  if (checkin?.emergency_triggered) { level = 'danger'; factors.push('emergency_triggered'); }
  if (checkin?.triage_severity === 'high') { level = 'danger'; factors.push('triage_severity_high'); }
  if (glucose !== null && glucose > 250) { level = 'danger'; factors.push('glucose_very_high'); }
  if (glucose !== null && glucose < 70) { level = 'danger'; factors.push('glucose_very_low'); }
  if (systolic !== null && systolic > 180) { level = 'danger'; factors.push('systolic_very_high'); }

  // Monitor conditions (only upgrade if not already danger)
  if (level !== 'danger') {
    if (checkin?.initial_status === 'tired') { level = 'monitor'; factors.push('status_tired'); }
    if (checkin?.triage_severity === 'medium') { level = 'monitor'; factors.push('triage_severity_medium'); }
    if (glucose !== null && glucose >= 200 && glucose <= 250) { level = 'monitor'; factors.push('glucose_high'); }
    if (systolic !== null && systolic >= 140 && systolic <= 180) { level = 'monitor'; factors.push('systolic_high'); }
  }

  const result = { level, factors, checkinDone };
  await cacheSet(`health:score:${userId}`, result, 180); // 3 min
  return result;
}

/**
 * DEV ONLY — Simulate time passing by setting next_checkin_at to past
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object|null>} - Updated session row or null
 */
async function simulateTimePassing(pool, userId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const { rows } = await pool.query(
    `UPDATE health_checkins
     SET next_checkin_at = NOW() - INTERVAL '1 minute', updated_at = NOW()
     WHERE user_id = $1 AND session_date = $2 AND resolved_at IS NULL
     RETURNING id, next_checkin_at, flow_state, current_status`,
    [userId, today]
  );
  return rows[0] || null;
}

/**
 * DEV ONLY — Reset today's checkin session for testing
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<void>}
 */
async function resetTodayCheckin(pool, userId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  await pool.query(
    `DELETE FROM health_checkins WHERE user_id = $1 AND session_date = $2`,
    [userId, today]
  );
}

module.exports = {
  getTodayCheckin,
  getYesterdaySession,
  startCheckin,
  recordFollowUp,
  processTriageStep,
  triggerEmergency,
  runCheckinFollowUps,
  runMorningCheckin,
  confirmCaregiverAlert,
  getPendingCaregiverAlerts,
  runAlertConfirmationFollowUps,
  getHealthReport,
  getHealthScore,
  simulateTimePassing,
  resetTodayCheckin,
};
