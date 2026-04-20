'use strict';

/**
 * Re-engagement Service — Kéo user quay lại
 *
 * Targets:
 *   - semi_active (1-3 days inactive) → gentle nudge
 *   - inactive (4-7 days inactive) → concerned tone, mention symptoms
 *   - churned (>7 days inactive) → urgent + alert care-circle
 *
 * Escalation by inactive_days:
 *   D1-2: gentle nudge, mention last symptom if any
 *   D3-4: concerned, increase urgency
 *   D5-7: worried, suggest checking with family
 *   D8+:  urgent, alert care-circle
 *
 * Constraints:
 *   - Max 1 re-engagement push/day per user (dedup)
 *   - Max 1 care-circle alert/3 days per user
 *   - Skip if user has recent activity (lifecycle updates segment)
 */

const { getHonorifics } = require('../../lib/honorifics');
const { getUsersBySegment } = require('../profile/lifecycle.service');

// ─── Re-engagement Templates ────────────────────────────────────────────────

const REENGAGEMENT_TEMPLATES = {
  // D1-2: gentle nudge
  d2_gentle_with_symptom: {
    id: 'reengage_d2_gentle_symptom',
    level: 'gentle',
    vi: '💬 {callName} ơi, hôm trước {honorific} có bị {symptom}. Hôm nay {honorific} thế nào rồi?',
    en: '💬 {callName}, you had {symptom} recently. How are you feeling today?',
  },
  d2_gentle_no_symptom: {
    id: 'reengage_d2_gentle',
    level: 'gentle',
    vi: '👋 {callName} ơi, {selfRef} chưa thấy {honorific} check-in. Mọi thứ ổn chứ ạ?',
    en: '👋 {callName}, I haven\'t seen you check in today. Is everything okay?',
  },

  // D3-4: concerned, mention symptom + previous severity
  d4_concerned_with_symptom: {
    id: 'reengage_d4_concerned_symptom',
    level: 'concerned',
    vi: '😟 {callName} ơi, mấy hôm nay {honorific} chưa cập nhật. {symptom} có đỡ hơn không ạ? {selfRef} hơi lo',
    en: '{callName}, you haven\'t updated for a few days. Has your {symptom} improved?',
  },
  d4_concerned_was_severe: {
    id: 'reengage_d4_concerned_severe',
    level: 'concerned',
    vi: '🩺 {callName} ơi, lần trước {honorific} có triệu chứng nặng. {selfRef} hơi lo, {honorific} ổn không?',
    en: '{callName}, you had severe symptoms last time. I\'m concerned, are you okay?',
  },
  d4_concerned_default: {
    id: 'reengage_d4_concerned',
    level: 'concerned',
    vi: '📋 {callName} ơi, {days} ngày nay {honorific} chưa check-in. {selfRef} muốn nghe tin {honorific}',
    en: '{callName}, it\'s been {days} days. I\'d like to hear from you',
  },

  // D5-7: worried, suggest family
  d7_worried_with_symptom: {
    id: 'reengage_d7_worried_symptom',
    level: 'worried',
    vi: '⚠️ {callName} ơi, đã {days} ngày rồi. Nếu {honorific} vẫn còn {symptom}, mình nên kiểm tra lại sớm nhé',
    en: '{callName}, it\'s been {days} days. If your {symptom} persists, please check in soon',
  },
  d7_worried_default: {
    id: 'reengage_d7_worried',
    level: 'worried',
    vi: '😔 {callName} ơi, {days} ngày rồi {honorific} chưa quay lại. {selfRef} mong {honorific} ổn',
    en: '{callName}, {days} days without you. I hope you\'re okay',
  },

  // D8+: urgent, churned
  d8_urgent: {
    id: 'reengage_d8_urgent',
    level: 'urgent',
    vi: '🚨 {callName} ơi, {selfRef} rất lo cho {honorific}. Đã {days} ngày rồi. {honorific} vào check-in ngay nhé',
    en: '{callName}, I\'m really worried. It\'s been {days} days. Please check in now',
  },

  // Care-circle alert (gửi cho gia đình)
  care_circle_alert: {
    id: 'reengage_care_circle',
    level: 'family',
    vi: '👨‍👩‍👦 Người thân của bạn ({patientName}) đã không check-in {days} ngày. Vui lòng liên hệ kiểm tra giúp',
    en: 'Your family member ({patientName}) hasn\'t checked in for {days} days. Please reach out',
  },
};

// ─── Escalation Level Mapping ───────────────────────────────────────────────

/**
 * Determine escalation level from inactive_days.
 * Returns: { level, includeFamily, mentionSymptom }
 */
function getEscalationLevel(inactiveDays) {
  if (inactiveDays >= 8) return { level: 'urgent', includeFamily: true,  mentionSymptom: true };
  if (inactiveDays >= 5) return { level: 'worried', includeFamily: false, mentionSymptom: true };
  if (inactiveDays >= 3) return { level: 'concerned', includeFamily: false, mentionSymptom: true };
  if (inactiveDays >= 1) return { level: 'gentle', includeFamily: false, mentionSymptom: true };
  return null; // Active user, no escalation
}

// ─── Build re-engagement context ────────────────────────────────────────────

/**
 * Lightweight context query for re-engagement.
 * Includes: top symptom, last severity, lifecycle.
 */
async function buildReengagementContext(pool, userId) {
  const [clusterRes, sessionRes, lifecycleRes] = await Promise.all([
    pool.query(
      `SELECT display_name, trend FROM problem_clusters
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY priority DESC LIMIT 1`,
      [userId]
    ),
    pool.query(
      `SELECT severity FROM script_sessions
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    ),
    pool.query(
      `SELECT segment, inactive_days FROM user_lifecycle WHERE user_id = $1`,
      [userId]
    ),
  ]);

  return {
    topSymptom: clusterRes.rows[0] || null,
    lastSeverity: sessionRes.rows[0]?.severity || null,
    lifecycle: lifecycleRes.rows[0] || { segment: 'active', inactive_days: 0 },
  };
}

// ─── Select template based on escalation + context ──────────────────────────

function selectReengagementTemplate(ctx, escalation) {
  const hasSymptom = ctx.topSymptom !== null;
  const wasSevere = ctx.lastSeverity === 'high';

  if (escalation.level === 'urgent') {
    return { template: REENGAGEMENT_TEMPLATES.d8_urgent };
  }

  if (escalation.level === 'worried') {
    if (hasSymptom) return { template: REENGAGEMENT_TEMPLATES.d7_worried_with_symptom };
    return { template: REENGAGEMENT_TEMPLATES.d7_worried_default };
  }

  if (escalation.level === 'concerned') {
    if (hasSymptom) return { template: REENGAGEMENT_TEMPLATES.d4_concerned_with_symptom };
    if (wasSevere) return { template: REENGAGEMENT_TEMPLATES.d4_concerned_was_severe };
    return { template: REENGAGEMENT_TEMPLATES.d4_concerned_default };
  }

  if (escalation.level === 'gentle') {
    if (hasSymptom) return { template: REENGAGEMENT_TEMPLATES.d2_gentle_with_symptom };
    return { template: REENGAGEMENT_TEMPLATES.d2_gentle_no_symptom };
  }

  return null;
}

// ─── Render template ────────────────────────────────────────────────────────

function renderReengagementMessage(template, ctx, user, escalation) {
  const lang = user.lang || 'vi';
  const h = getHonorifics(user);

  let text = lang === 'en' ? template.en : template.vi;

  // Honorific replacements
  text = text.replace(/\{callName\}/g, h.callName);
  text = text.replace(/\{honorific\}/g, h.honorific);
  text = text.replace(/\{Honorific\}/g, h.Honorific);
  text = text.replace(/\{selfRef\}/g, h.selfRef);

  // Context replacements
  const symptomFallback = lang === 'en' ? 'symptoms' : 'triệu chứng';
  text = text.replace(/\{symptom\}/g, ctx.topSymptom?.display_name || symptomFallback);
  text = text.replace(/\{days\}/g, String(ctx.lifecycle.inactive_days || 0));

  return { text, templateId: template.id, level: template.level };
}

// ─── Generate re-engagement message for a user ──────────────────────────────

/**
 * Generate full re-engagement message + decide if should send.
 *
 * @returns {{ shouldSend: boolean, message: object, escalation: object } | null}
 */
async function generateReengagementMessage(pool, userId, user) {
  const ctx = await buildReengagementContext(pool, userId);

  // Skip if user is now active
  if (ctx.lifecycle.segment === 'active') {
    return null;
  }

  const escalation = getEscalationLevel(ctx.lifecycle.inactive_days);
  if (!escalation) return null;

  const selection = selectReengagementTemplate(ctx, escalation);
  if (!selection) return null;

  const message = renderReengagementMessage(selection.template, ctx, user, escalation);

  return {
    shouldSend: true,
    message,
    escalation,
    context: ctx,
  };
}

// ─── Care-circle alert (sent to family members) ─────────────────────────────

async function sendCareCircleAlert(pool, sendAndSave, patientId, patientName, inactiveDays) {
  // Get active care circle members (user_connections + can_receive_alerts)
  const { rows: guardians } = await pool.query(
    `SELECT u.id, u.push_token, u.display_name,
            COALESCE(u.language_preference, 'vi') AS lang,
            uc.relationship_type,
            CASE WHEN uc.requester_id = $1 THEN 'requester' ELSE 'addressee' END as patient_side
     FROM user_connections uc
     JOIN users u ON u.id = CASE
       WHEN uc.requester_id = $1 THEN uc.addressee_id
       ELSE uc.requester_id
     END
     WHERE (uc.requester_id = $1 OR uc.addressee_id = $1)
       AND uc.status = 'accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean, false) = true
       AND u.deleted_at IS NULL`,
    [patientId]
  );

  let sent = 0;
  for (const guardian of guardians) {
    // Dedup: skip if alert sent in last 3 days
    const { rows: recent } = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'caregiver_alert'
       AND created_at >= NOW() - INTERVAL '3 days'
       AND data->>'reengage_patient_id' = $2 LIMIT 1`,
      [guardian.id, String(patientId)]
    );
    if (recent.length > 0) continue;

    // Render message with relationship
    const lang = guardian.lang || 'vi';
    const { getPatientRoleForCaregiver } = require('../../lib/relation');
    const patientDisplay = guardian.patient_side === 'requester'
      ? getPatientRoleForCaregiver(guardian.relationship_type, patientName || 'người thân', lang, true)
      : (patientName || 'người thân');

    const tmpl = REENGAGEMENT_TEMPLATES.care_circle_alert;
    let text = lang === 'en' ? tmpl.en : tmpl.vi;
    text = text.replace(/\{patientName\}/g, patientDisplay);
    text = text.replace(/\{days\}/g, String(inactiveDays));

    const title = lang === 'en' ? 'Care Alert' : 'Cảnh báo người thân';

    const ok = await sendAndSave(pool, guardian, 'caregiver_alert', title, text, {
      type: 'caregiver_alert',
      reengage_patient_id: patientId,
      inactive_days: inactiveDays,
      templateId: tmpl.id,
    });
    if (ok) sent++;
  }
  return sent;
}

// ─── Main runner — called by cron ───────────────────────────────────────────

async function runReengagement(pool, sendAndSave) {
  // Get inactive + churned + semi_active users
  // (semi_active = 1-3 days inactive — also gets gentle nudge)
  const [semiActive, inactive, churned] = await Promise.all([
    getUsersBySegment(pool, 'semi_active'),
    getUsersBySegment(pool, 'inactive'),
    getUsersBySegment(pool, 'churned'),
  ]);

  const allUsers = [...semiActive, ...inactive, ...churned];
  let sent = 0;
  let careAlertsSent = 0;
  let skipped = 0;

  for (const lc of allUsers) {
    try {
      // Get full user details
      const { rows: users } = await pool.query(
        `SELECT u.id, u.push_token, u.display_name, u.full_name,
                COALESCE(u.language_preference, 'vi') AS lang,
                uop.birth_year, uop.gender
         FROM users u
         LEFT JOIN user_onboarding_profiles uop ON uop.user_id = u.id
         WHERE u.id = $1 AND u.deleted_at IS NULL`,
        [lc.user_id]
      );
      if (users.length === 0) continue;
      const user = users[0];

      // Skip if no push token (still log to DB but no push)
      // Allow continue — sendAndSave handles missing token

      // Dedup: max 1 re-engagement per day
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'reengagement'
         AND DATE(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')
             = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') LIMIT 1`,
        [user.id]
      );
      if (recent.length > 0) {
        skipped++;
        continue;
      }

      // Generate message
      const result = await generateReengagementMessage(pool, user.id, user);
      if (!result || !result.shouldSend) continue;

      // Send re-engagement push
      const { Honorific } = getHonorifics(user);
      const title = user.lang === 'en' ? 'Health check-in' : `${Honorific} ơi, mời quay lại`;

      const ok = await sendAndSave(pool, user, 'reengagement', title, result.message.text, {
        type: 'reengagement',
        templateId: result.message.templateId,
        level: result.escalation.level,
        inactive_days: lc.inactive_days,
      });
      if (ok) sent++;

      // Care-circle alert if escalation level requires it
      if (result.escalation.includeFamily) {
        const careSent = await sendCareCircleAlert(pool, sendAndSave, user.id, user.display_name || user.full_name, lc.inactive_days);
        careAlertsSent += careSent;
      }
    } catch (err) {
      console.warn(`[Reengagement] Failed for user ${lc.user_id}:`, err.message);
    }
  }

  return {
    type: 'reengagement',
    total: allUsers.length,
    sent,
    careAlertsSent,
    skipped,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  runReengagement,
  generateReengagementMessage,
  buildReengagementContext,
  selectReengagementTemplate,
  renderReengagementMessage,
  getEscalationLevel,
  sendCareCircleAlert,
  REENGAGEMENT_TEMPLATES,
};
