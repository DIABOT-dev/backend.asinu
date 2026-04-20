'use strict';

/**
 * Script Session Service
 *
 * Data-access layer for script_sessions and related tables.
 * All pool.query calls for script check-in sessions live here.
 */

const { dispatch: dispatchNotification } = require('../../core/notification/notification.orchestrator');

// ─── Profile helper ────────────────────────────────────────────────────────

/**
 * Get user onboarding profile (shared helper).
 */
async function getProfile(pool, userId) {
  const { rows } = await pool.query(
    `SELECT uop.*, u.id as uid, u.display_name, u.full_name
     FROM user_onboarding_profiles uop
     JOIN users u ON u.id = uop.user_id
     WHERE uop.user_id = $1`,
    [userId]
  );
  return rows[0] || {};
}

// ─── Session CRUD ──────────────────────────────────────────────────────────

/**
 * Create a new script session and link it to a health_checkins row.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {number|null} scriptId
 * @param {string} clusterKey
 * @param {string} [sessionType='initial']
 * @param {string} status - 'tired' | 'very_tired'
 * @returns {Promise<object>} created session row
 */
async function createSession(pool, userId, scriptId, clusterKey, sessionType = 'initial', status = 'tired') {
  // 1. Insert script_session
  const { rows: sessionRows } = await pool.query(
    `INSERT INTO script_sessions
       (user_id, script_id, cluster_key, session_type, answers, current_step)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, 0)
     RETURNING *`,
    [userId, scriptId, clusterKey, sessionType]
  );
  const session = sessionRows[0];

  // 2. Create/update health_checkins for compatibility
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const flowState = status === 'very_tired' ? 'high_alert' : 'follow_up';
  try {
    const result = await pool.query(
      `INSERT INTO health_checkins
         (user_id, session_date, initial_status, current_status, flow_state, last_response_at, updated_at)
       VALUES ($1, $2, $3, $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, session_date) DO UPDATE SET
         current_status = $3, flow_state = $4, last_response_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [userId, today, status, flowState]
    );
    // 3. Link script session to checkin
    const checkinId = result.rows[0]?.id;
    if (checkinId) {
      await pool.query(
        `UPDATE script_sessions SET checkin_id = $1 WHERE id = $2`,
        [checkinId, session.id]
      );
      session.checkin_id = checkinId;
    }
  } catch (_) {
    // non-fatal — session still usable without checkin link
  }

  return session;
}

/**
 * Get a session by ID and user ID.
 */
async function getSession(pool, sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM script_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  return rows[0] || null;
}

/**
 * Get today's most recent session for a user (with script_data joined).
 */
async function getTodaySession(pool, userId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const { rows } = await pool.query(
    `SELECT ss.*, ts.script_data
     FROM script_sessions ss
     LEFT JOIN triage_scripts ts ON ts.id = ss.script_id
     WHERE ss.user_id = $1
       AND DATE(ss.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = $2
     ORDER BY ss.created_at DESC LIMIT 1`,
    [userId, today]
  );
  return rows[0] || null;
}

/**
 * Update session answers and current step (mid-script).
 */
async function updateAnswers(pool, sessionId, answers, currentStep) {
  await pool.query(
    `UPDATE script_sessions SET
       answers = $2::jsonb, current_step = $3
     WHERE id = $1`,
    [sessionId, JSON.stringify(answers), currentStep]
  );
}

/**
 * Mark a session as completed with conclusion data.
 */
async function completeSession(pool, sessionId, answers, conclusion) {
  await pool.query(
    `UPDATE script_sessions SET
       answers = $2::jsonb,
       current_step = $3,
       is_completed = TRUE,
       severity = $4,
       score_details = $5::jsonb,
       needs_doctor = $6,
       needs_family_alert = $7,
       follow_up_hours = $8,
       conclusion_summary = $9,
       conclusion_recommendation = $10,
       conclusion_close_message = $11,
       completed_at = NOW()
     WHERE id = $1`,
    [
      sessionId,
      JSON.stringify(answers),
      answers.length,
      conclusion.severity,
      JSON.stringify({
        matchedRuleIndex: conclusion.matchedRuleIndex,
        modifiersApplied: conclusion.modifiersApplied,
      }),
      conclusion.needsDoctor || false,
      conclusion.needsFamilyAlert || false,
      conclusion.followUpHours || 6,
      conclusion.summary,
      conclusion.recommendation,
      conclusion.closeMessage,
    ]
  );
}

/**
 * Mark a session as emergency-completed.
 */
async function markEmergency(pool, sessionId) {
  await pool.query(
    `UPDATE script_sessions SET
       is_completed = TRUE, severity = 'critical',
       conclusion_summary = 'Emergency detected',
       completed_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );
}

/**
 * Update the linked health_checkins row after session completion.
 */
async function updateCheckinFromSession(pool, checkinId, severity, summary, followUpHours) {
  const nextAt = new Date(Date.now() + (followUpHours || 6) * 3600000);
  await pool.query(
    `UPDATE health_checkins SET
       triage_severity = $2,
       triage_summary = $3,
       triage_completed_at = NOW(),
       next_checkin_at = $4,
       flow_state = CASE
         WHEN $2 = 'high' OR $2 = 'critical' THEN 'high_alert'
         WHEN $2 = 'medium' THEN 'follow_up'
         ELSE 'monitoring'
       END,
       updated_at = NOW()
     WHERE id = $1`,
    [checkinId, severity, summary, nextAt]
  );
}

/**
 * Get script_data by script ID.
 */
async function getScriptDataById(pool, scriptId) {
  const { rows } = await pool.query(
    `SELECT script_data FROM triage_scripts WHERE id = $1`,
    [scriptId]
  );
  return rows[0]?.script_data || null;
}

// ─── Multi-symptom helpers ────────────────────────────────────────────────

/**
 * Store multi-symptom metadata on a session's score_details.
 */
async function setMultiSymptomMeta(pool, sessionId, multiSymptomData) {
  await pool.query(
    `UPDATE script_sessions SET
       score_details = jsonb_set(COALESCE(score_details, '{}'::jsonb), '{multi_symptom}', $2::jsonb)
     WHERE id = $1`,
    [sessionId, JSON.stringify(multiSymptomData)]
  );
}

/**
 * Switch a session to the next cluster in a multi-symptom flow.
 */
async function switchToNextCluster(pool, sessionId, nextClusterKey, nextScriptId, multiSymptomData) {
  await pool.query(
    `UPDATE script_sessions SET
       cluster_key = $2,
       script_id = $3,
       answers = '[]'::jsonb,
       current_step = 0,
       score_details = jsonb_set(COALESCE(score_details, '{}'::jsonb), '{multi_symptom}', $4::jsonb)
     WHERE id = $1`,
    [sessionId, nextClusterKey, nextScriptId, JSON.stringify(multiSymptomData)]
  );
}

// ─── Family alert ──────────────────────────────────────────────────────────

/**
 * Alert family caregivers if needed (checks dedup, sends push, marks alerted).
 */
async function alertFamilyIfNeeded(pool, userId, checkinId, conclusion) {
  const { getPatientRoleForCaregiver } = require('../../lib/relation');
  const { t } = require('../../i18n');

  // Check if already alerted today
  const { rows } = await pool.query(
    `SELECT family_alerted FROM health_checkins WHERE id = $1`,
    [checkinId]
  );
  if (rows[0]?.family_alerted) return;

  // Get patient name
  const { rows: patientRows } = await pool.query(
    `SELECT display_name, full_name FROM users WHERE id = $1`,
    [userId]
  );
  const patient = patientRows[0] || {};
  const patientFullName = patient.display_name || patient.full_name || 'Người thân';
  const patientName = patientFullName.trim().split(/\s+/).pop();

  // Get caregivers từ user_connections (bảng mới, có permission + relationship)
  const { rows: caregivers } = await pool.query(
    `SELECT u.id as caregiver_id, u.push_token,
            COALESCE(u.language_preference, 'vi') as cg_lang,
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

  for (const cg of caregivers) {
    if (!cg.push_token) continue;
    const cgLang = cg.cg_lang || 'vi';
    const patientDisplay = cg.patient_side === 'requester'
      ? getPatientRoleForCaregiver(cg.relationship_type, patientName, cgLang, true)
      : patientName;
    try {
      await dispatchNotification(pool, {
        userId: cg.caregiver_id,
        type: 'caregiver_alert',
        title: t('checkin.health_check_needed_title', cgLang),
        body: conclusion.summary || t('checkin.no_response_family_body', cgLang, { name: patientDisplay }),
        data: { patient_id: userId, checkin_id: checkinId, severity: conclusion.severity },
        priority: 'high',
      });
    } catch (err) {
      console.error(`[ScriptSession] Failed to alert caregiver ${cg.caregiver_id}:`, err.message);
    }
  }

  // Mark as alerted
  await pool.query(
    `UPDATE health_checkins SET family_alerted = TRUE, family_alerted_at = NOW() WHERE id = $1`,
    [checkinId]
  );
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  getProfile,
  createSession,
  getSession,
  getTodaySession,
  updateAnswers,
  completeSession,
  markEmergency,
  updateCheckinFromSession,
  getScriptDataById,
  alertFamilyIfNeeded,
  setMultiSymptomMeta,
  switchToNextCluster,
};
