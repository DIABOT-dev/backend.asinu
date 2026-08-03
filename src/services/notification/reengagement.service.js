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
    vi: '{CallName} ơi, {symptom} lần trước còn không? Cập nhật hôm nay để Asinu theo dõi tiếp nhé.',
    en: 'Your {symptom} was recorded recently. If it is still present, update your health record today.',
  },
  d2_gentle_no_symptom: {
    id: 'reengage_d2_gentle',
    level: 'gentle',
    vi: '{CallName} ơi, hôm nay chưa có cập nhật. Mở app ghi lại để Asinu theo dõi tiếp nhé.',
    en: 'There is no health update today. Open the app to record your current status.',
  },

  // D3-4: concerned, mention symptom + previous severity
  d4_concerned_with_symptom: {
    id: 'reengage_d4_concerned_symptom',
    level: 'concerned',
    vi: '{CallName} ơi, đã vài ngày chưa cập nhật. Nếu {symptom} còn, ghi lại để Asinu theo dõi tiếp; nếu nặng hơn, nên đi khám.',
    en: 'There has been no update for a few days. If your {symptom} persists, monitor it and seek care if it worsens.',
  },
  d4_concerned_was_severe: {
    id: 'reengage_d4_concerned_severe',
    level: 'concerned',
    vi: '{CallName} ơi, lần trước {honorific} ghi nhận triệu chứng nặng. Nếu chưa đỡ, nên liên hệ cơ sở y tế.',
    en: 'You recorded severe symptoms recently. If they have not improved, contact a healthcare provider.',
  },
  d4_concerned_default: {
    id: 'reengage_d4_concerned',
    level: 'concerned',
    vi: '{CallName} ơi, đã {days} ngày chưa có cập nhật. Ghi lại khi tiện để Asinu theo dõi tiếp nhé.',
    en: 'There has been no health update for {days} days. Record your current status when you can.',
  },

  // D5-7: worried, suggest family
  d7_worried_with_symptom: {
    id: 'reengage_d7_worried_symptom',
    level: 'worried',
    vi: '{CallName} ơi, đã {days} ngày từ lần cập nhật gần nhất. Nếu {symptom} còn kéo dài, nên đi khám nhé.',
    en: 'It has been {days} days since your last update. If your {symptom} persists, consider seeing a doctor.',
  },
  d7_worried_default: {
    id: 'reengage_d7_worried',
    level: 'worried',
    vi: '{CallName} ơi, đã {days} ngày chưa có cập nhật. Mở app ghi lại hôm nay để Asinu theo dõi tiếp nhé.',
    en: 'There has been no update for {days} days. Open the app to record today\'s status.',
  },

  // D8+: urgent, churned
  d8_urgent: {
    id: 'reengage_d8_urgent',
    level: 'urgent',
    vi: '{CallName} ơi, đã {days} ngày chưa có cập nhật. Nếu đang không ổn, hãy liên hệ người thân hoặc cơ sở y tế.',
    en: 'There has been no health update for {days} days. If you feel unwell, contact a family member or healthcare provider.',
  },

  // Care-circle alert (gửi cho gia đình)
  care_circle_alert: {
    id: 'reengage_care_circle',
    level: 'family',
    vi: '{patientName} đã {days} ngày chưa cập nhật sức khỏe. Vui lòng liên hệ để kiểm tra.',
    en: '{patientName} has not shared a health update for {days} days. Please check in with them.',
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
      `SELECT segment, inactive_days, last_checkin_at FROM user_lifecycle WHERE user_id = $1`,
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

  // A user who has never checked in is new, not inactive. Legacy lifecycle
  // rows used inactive_days=999 for this case, so guard by the actual date.
  if (ctx.lifecycle.segment === 'active' || !ctx.lifecycle.last_checkin_at) {
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

    const title = lang === 'en' ? 'Health check needed' : 'Cần kiểm tra sức khỏe';

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

  // Re-engagement only applies to users who have completed at least one
  // check-in. This excludes legacy rows with no check-in and inactive_days=999.
  const allUsers = [...semiActive, ...inactive, ...churned]
    .filter((user) => user.last_checkin_at != null);
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
      const title = user.lang === 'en' ? 'Health update' : 'Cập nhật sức khỏe';

      const ok = await sendAndSave(pool, user, 'reengagement', title, result.message.text, {
        type: 'reengagement',
        templateId: result.message.templateId,
        level: result.escalation.level,
        inactive_days: lc.inactive_days,
      });
      if (ok) sent++;

      // Care-circle alert if escalation level requires it
      if (result.escalation.includeFamily) {
        const careSent = await sendCareCircleAlert(pool, sendAndSave, user.id, user.full_name || user.display_name, lc.inactive_days);
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
