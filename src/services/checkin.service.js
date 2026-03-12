/**
 * Health Check-in Service
 *
 * Flow states:
 *   monitoring  — "Tôi ổn", check lại lúc 21h
 *   follow_up   — "Hơi mệt", check lại sau 3h → 4h
 *   high_alert  — "Rất mệt", check lại sau 2h
 *   resolved    — Người dùng xác nhận đã ổn
 *
 * No-response escalation:
 *   miss × 1 → push nhắc
 *   miss × 2 + high_alert + risk_score >= 30 → alert gia đình
 */

const { sendPushNotification } = require('./push.notification.service');
const { getNextTriageQuestion, buildContinuityMessage, calcFollowUpHours } = require('./checkin.ai.service');
const { t } = require('../i18n');

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
  const tasks = [
    pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data) VALUES ($1,$2,$3,$4,$5)`,
      [userId, type, title, body, JSON.stringify(data)]
    ),
  ];
  if (pushToken) {
    tasks.push(sendPushNotification([pushToken], title, body, { type, ...data }));
  }
  await Promise.allSettled(tasks);
}

const TZ = 'Asia/Ho_Chi_Minh';

// Ngưỡng risk score để cảnh báo gia đình tự động
const FAMILY_ALERT_RISK_THRESHOLD = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowVN() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

/** 21:00 VN time today */
function todayEvening9pm() {
  const vn = nowVN();
  vn.setHours(21, 0, 0, 0);
  return vn;
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
  const vn = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  vn.setDate(vn.getDate() - 1);
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
       current_status   = $3,
       flow_state       = $4,
       next_checkin_at  = $5,
       last_response_at = NOW(),
       no_response_count= 0,
       resolved_at      = CASE WHEN $3 = 'fine' AND health_checkins.flow_state = 'monitoring'
                               THEN health_checkins.resolved_at ELSE NULL END,
       updated_at       = NOW()
     RETURNING *`,
    [userId, date, status, flowState, nextAt]
  );

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

  let flowState = session.flow_state;
  let resolvedAt = null;

  if (newStatus === 'fine') {
    // Recovering: move to light monitoring
    flowState = 'monitoring';
  } else if (newStatus === 'very_tired' || session.flow_state === 'high_alert') {
    // Escalate or maintain high alert
    flowState = 'high_alert';
  } else {
    flowState = 'follow_up';
  }

  // Count how many follow-ups so far for this session
  const followUpCount = session.no_response_count + 1;

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
  const [glucoseRes, bpRes, weightRes, checkinsRes] = await Promise.all([
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
  ]);

  return {
    recentGlucose: glucoseRes.rows,
    recentBP: bpRes.rows,
    latestWeight: weightRes.rows[0] || null,
    previousCheckins: checkinsRes.rows,
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
  if (!rows.length) throw new Error('Session not found');
  const session = rows[0];

  // Xác định phase: nếu session có triage_completed_at rồi → đây là follow-up
  // Hoặc nếu flow_state cho thấy đây là follow-up định kỳ
  const isFollowUpPhase = session.triage_completed_at != null;

  const [profile, healthContext] = await Promise.all([
    getUserProfile(pool, userId),
    getRecentHealthContext(pool, userId),
  ]);

  const result = await getNextTriageQuestion({
    status:                  session.initial_status,
    phase:                   isFollowUpPhase ? 'followup' : 'initial',
    lang:                    profile.lang || 'vi',
    profile,
    healthContext,
    previousAnswers,
    previousSessionSummary:  session.triage_summary || null,
  });

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
      await sendCheckinNotification(
        pool, userId, null,
        'caregiver_alert',
        'Asinu đã thông báo người thân',
        'Dựa trên tình trạng của bạn, Asinu đã gửi thông báo đến vòng kết nối để họ có thể hỗ trợ bạn.',
        { checkinId: String(checkinId) }
      );
    }
  }

  return result;
}

// ─── Emergency ───────────────────────────────────────────────────────────────

/**
 * User pressed emergency button.
 * Alerts ALL care circle members with can_receive_alerts=true.
 */
async function triggerEmergency(pool, userId, location) {
  // Mark session
  await pool.query(
    `INSERT INTO health_checkins
       (user_id, session_date, initial_status, current_status, flow_state,
        emergency_triggered, emergency_location, resolved_at, updated_at)
     VALUES ($1,$2,'very_tired','very_tired','high_alert',true,$3::jsonb,NULL,NOW())
     ON CONFLICT (user_id, session_date) DO UPDATE SET
       emergency_triggered = true,
       emergency_location  = $3::jsonb,
       flow_state          = 'high_alert',
       updated_at          = NOW()`,
    [userId, checkinDateVN(), JSON.stringify(location || null)]
  );

  // Get user info
  const { rows: userRows } = await pool.query(
    `SELECT u.display_name, u.full_name, u.phone_number,
            COALESCE(u.language_preference,'vi') as lang
     FROM users u WHERE u.id = $1`,
    [userId]
  );
  const user = userRows[0] || {};
  const userName = user.display_name || user.full_name || 'Người dùng';

  // Get care circle members who can receive alerts
  const { rows: caregivers } = await pool.query(
    `SELECT u.id, u.push_token
     FROM user_connections uc
     JOIN users u ON u.id = uc.caregiver_id
     WHERE uc.patient_id = $1
       AND uc.status = 'accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean, false) = true`,
    [userId]
  );

  const locationStr = location
    ? ` (${location.lat?.toFixed(4)}, ${location.lng?.toFixed(4)})`
    : '';
  const title = 'Khẩn cấp — Cần giúp đỡ ngay';
  const body  = `${userName} đang cần giúp đỡ khẩn cấp${locationStr}. Vui lòng kiểm tra ngay.`;
  const data  = { userId: String(userId), location };

  for (const cg of caregivers) {
    await sendCheckinNotification(
      pool, cg.id, cg.push_token || null,
      'emergency', title, body, data
    );
  }

  return {
    ok: true,
    caregiversAlerted: caregivers.length,
    message: caregivers.length
      ? `Đã thông báo ${caregivers.length} người trong vòng kết nối.`
      : 'Không có người thân nào trong vòng kết nối để thông báo.',
  };
}

// ─── No-response escalation (called by cron) ─────────────────────────────────

/**
 * Check all active sessions where next_checkin_at has passed.
 * Send follow-up push or escalate to family alert.
 */
async function runCheckinFollowUps(pool) {
  const now = new Date();

  // Sessions overdue (next_checkin_at passed and not resolved)
  const { rows: overdue } = await pool.query(
    `SELECT hc.*, u.push_token, u.display_name, u.full_name,
            COALESCE(u.language_preference,'vi') as lang,
            uop.risk_score
     FROM health_checkins hc
     JOIN users u ON u.id = hc.user_id
     LEFT JOIN user_onboarding_profiles uop ON uop.user_id = hc.user_id
     WHERE hc.next_checkin_at <= $1
       AND hc.resolved_at IS NULL
       AND hc.session_date = $2
       AND hc.flow_state != 'resolved'`,
    [now, checkinDateVN()]
  );

  let sent = 0;
  let escalated = 0;

  for (const session of overdue) {
    const newMissCount = session.no_response_count + 1;

    if (newMissCount === 1) {
      // First miss → push + in-app nhắc
      const msg = session.flow_state === 'high_alert'
        ? 'Bạn có ổn không? Chạm vào đây để phản hồi — chúng tôi đang theo dõi bạn.'
        : 'Tình trạng của bạn đã cải thiện chưa? Cập nhật nhanh để chúng tôi theo dõi cùng.';

      await sendCheckinNotification(
        pool, session.user_id, session.push_token,
        'checkin_followup',
        'Asinu đang hỏi thăm bạn',
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
    } else if (newMissCount === 2) {
      // Second miss: alert family if high_alert + risk_score >= threshold
      const riskScore = session.risk_score || 0;
      const shouldAlertFamily =
        session.flow_state === 'high_alert' &&
        riskScore >= FAMILY_ALERT_RISK_THRESHOLD &&
        !session.family_alerted;

      if (shouldAlertFamily) {
        await alertFamily(pool, session);
        escalated++;
      }

      // Still push + in-app user one more time
      await sendCheckinNotification(
        pool, session.user_id, session.push_token,
        'checkin_followup_urgent',
        'Chúng tôi chưa nhận được phản hồi từ bạn',
        'Hãy cho Asinu biết bạn đang thế nào.',
        { checkinId: String(session.id) }
      );
      sent++;

      await pool.query(
        `UPDATE health_checkins SET no_response_count=$1, family_alerted=$2,
           family_alerted_at=CASE WHEN $2 THEN NOW() ELSE family_alerted_at END,
           updated_at=NOW() WHERE id=$3`,
        [newMissCount, shouldAlertFamily, session.id]
      );
    } else {
      // 3+ misses: mark resolved to stop spamming (user may have turned off phone)
      await pool.query(
        `UPDATE health_checkins SET resolved_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [session.id]
      );
    }
  }

  return { total: overdue.length, sent, escalated };
}

/** Alert all eligible care circle members about user's non-response */
async function alertFamily(pool, session, alertType = 'caregiver_alert') {
  const { rows: userRows } = await pool.query(
    `SELECT display_name, full_name FROM users WHERE id=$1`,
    [session.user_id]
  );
  const user = userRows[0] || {};
  const name = user.display_name || user.full_name || 'Người thân của bạn';

  const { rows: caregivers } = await pool.query(
    `SELECT u.id, u.push_token
     FROM user_connections uc
     JOIN users u ON u.id = uc.caregiver_id
     WHERE uc.patient_id = $1 AND uc.status='accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean,false) = true`,
    [session.user_id]
  );

  if (!caregivers.length) return;

  const title = alertType === 'emergency'
    ? 'Khẩn cấp — Cần giúp đỡ ngay'
    : 'Cần kiểm tra sức khoẻ';
  const body = alertType === 'emergency'
    ? `${name} đang cần giúp đỡ khẩn cấp. Vui lòng kiểm tra ngay.`
    : `${name} báo cáo không khoẻ và chưa phản hồi. Vui lòng liên lạc để kiểm tra.`;

  for (const cg of caregivers) {
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
      { alertId: String(alertId), patientId: String(session.user_id), checkinId: String(session.id) }
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
  const { rows } = await pool.query(
    `UPDATE caregiver_alert_confirmations
     SET confirmed_at=NOW(), confirmed_action=$1
     WHERE id=$2 AND caregiver_id=$3 AND confirmed_at IS NULL
     RETURNING *, (SELECT user_id FROM health_checkins WHERE id=checkin_id) AS patient_id`,
    [action, alertId, caregiverId]
  );
  if (!rows.length) return { ok: false, error: 'Not found or already confirmed' };

  const alert = rows[0];

  // Thông báo in-app cho user bệnh biết người thân đã xác nhận
  const { rows: cgRows } = await pool.query(
    `SELECT display_name, full_name FROM users WHERE id=$1`, [caregiverId]
  );
  const cgName = cgRows[0]?.display_name || cgRows[0]?.full_name || 'Người thân';
  const actionLabel = action === 'on_my_way' ? 'đang trên đường đến'
    : action === 'called' ? 'đã gọi điện cho bạn' : 'đã xem thông báo';

  await sendCheckinNotification(
    pool, alert.patient_id, null,
    'caregiver_confirmed',
    `${cgName} ${actionLabel}`,
    `${cgName} đã nhận thông báo về tình trạng của bạn và ${actionLabel}.`,
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
    patientName:   r.display_name || r.full_name || 'Người thân',
    currentStatus: r.current_status,
    flowState:     r.flow_state,
  }));
}

/**
 * Cron: gửi lại alert sau 30 phút nếu chưa xác nhận (tối đa 1 lần)
 */
async function runAlertConfirmationFollowUps(pool) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 phút trước
  const { rows } = await pool.query(
    `SELECT cac.*, u.push_token,
            p.display_name AS patient_name, p.full_name AS patient_full_name
     FROM caregiver_alert_confirmations cac
     JOIN users u ON u.id = cac.caregiver_id
     JOIN users p ON p.id = cac.patient_id
     WHERE cac.confirmed_at IS NULL
       AND cac.sent_at <= $1
       AND cac.resent_count = 0`,
    [cutoff]
  );

  for (const alert of rows) {
    const patientName = alert.patient_name || alert.patient_full_name || 'Người thân';
    const title = alert.alert_type === 'emergency'
      ? 'Nhắc lại: Khẩn cấp — Cần kiểm tra ngay'
      : 'Nhắc lại: Cần kiểm tra sức khoẻ';
    const body = `${patientName} vẫn cần được hỗ trợ. Bạn đã xác nhận chưa?`;

    await sendCheckinNotification(
      pool, alert.caregiver_id, alert.push_token || null,
      alert.alert_type, title, body,
      { alertId: String(alert.id), patientId: String(alert.patient_id), checkinId: String(alert.checkin_id) }
    );
    await pool.query(
      `UPDATE caregiver_alert_confirmations SET resent_count=1, resent_at=NOW() WHERE id=$1`,
      [alert.id]
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
    `SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
     FROM users u
     JOIN user_onboarding_profiles uop ON uop.user_id = u.id
     WHERE u.push_token IS NOT NULL
       AND u.deleted_at IS NULL
       AND uop.onboarding_completed_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM health_checkins hc
         WHERE hc.user_id = u.id AND hc.session_date = $1
       )`,
    [checkinDateVN()]
  );

  let sent = 0;
  for (const user of rows) {
    await sendCheckinNotification(
      pool, user.id, user.push_token,
      'morning_checkin',
      'Asinu hỏi thăm buổi sáng',
      'Sáng nay bạn cảm thấy thế nào? Nhấn để cập nhật tình trạng sức khoẻ.',
      {}
    );
    sent++;
  }

  return { type: 'morning_checkin', total: rows.length, sent };
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
};
