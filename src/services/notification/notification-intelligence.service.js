'use strict';

/**
 * Notification Intelligence Service
 *
 * Bộ não quyết định NỘI DUNG push notification dựa trên context user:
 *   - Triệu chứng gần nhất (problem_clusters)
 *   - Trend (improving / stable / worsening)
 *   - Lifecycle segment (active / semi_active / inactive / churned)
 *   - Severity gần nhất (script_sessions)
 *   - Streak OK days (risk_persistence)
 *
 * Không gọi AI — chỉ template + biến.
 * Mỗi message PHẢI map về template_id để truy vết.
 */

const { getHonorifics } = require('../../lib/honorifics');

// ─── User Context Builder ───────────────────────────────────────────────────

/**
 * Build full notification context cho 1 user.
 * Gộp dữ liệu từ nhiều bảng → 1 object phẳng.
 */
async function buildUserContext(pool, userId) {
  const [clusterRes, sessionRes, checkinRes, lifecycleRes, streakRes] = await Promise.all([
    // Top active cluster (triệu chứng nổi bật nhất)
    pool.query(
      `SELECT cluster_key, display_name, trend, count_7d, priority
       FROM problem_clusters
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY priority DESC, count_7d DESC
       LIMIT 3`,
      [userId]
    ),
    // Last script session (severity gần nhất)
    pool.query(
      `SELECT severity, needs_doctor, needs_family_alert, cluster_key, created_at
       FROM script_sessions
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    ),
    // Last few check-ins (chỉ trong 7 ngày gần nhất để tránh nhắc triệu chứng cũ)
    pool.query(
      `SELECT session_date, initial_status, flow_state, triage_summary
       FROM health_checkins
       WHERE user_id = $1 AND session_date >= NOW() - INTERVAL '7 days'
       ORDER BY session_date DESC LIMIT 5`,
      [userId]
    ),
    // Lifecycle
    pool.query(
      `SELECT segment, inactive_days, last_checkin_at FROM user_lifecycle WHERE user_id = $1`,
      [userId]
    ),
    // Streak OK days
    pool.query(
      `SELECT streak_ok_days, risk_tier FROM risk_persistence WHERE user_id = $1`,
      [userId]
    ).catch(() => ({ rows: [] })), // Table might not exist
  ]);

  const topClusters = clusterRes.rows;
  const lastSession = sessionRes.rows[0] || null;
  const recentCheckins = checkinRes.rows;
  const lifecycle = lifecycleRes.rows[0] || { segment: 'unknown', inactive_days: 0 };
  const risk = streakRes.rows[0] || { streak_ok_days: 0, risk_tier: null };

  // Derive context
  const topSymptom = topClusters[0] || null;
  const lastCheckin = recentCheckins[0] || null;
  // Đếm số ngày LIÊN TIẾP gần nhất mà user tired/very_tired (từ mới → cũ)
  let consecutiveTiredDays = 0;
  for (const c of recentCheckins) {
    if (c.initial_status === 'tired' || c.initial_status === 'very_tired') {
      consecutiveTiredDays++;
    } else {
      break; // gặp ngày không tired → dừng đếm
    }
  }

  return {
    topSymptom,           // { cluster_key, display_name, trend, count_7d }
    topClusters,          // top 3 clusters
    lastSession,          // { severity, needs_doctor, cluster_key }
    lastCheckin,          // { session_date, initial_status, triage_summary }
    consecutiveTiredDays, // số ngày liên tiếp tired/very_tired
    lifecycle,            // { segment, inactive_days }
    streakOkDays: risk.streak_ok_days || 0,
    riskTier: risk.risk_tier || null,
  };
}

// ─── Template System ────────────────────────────────────────────────────────

/**
 * Morning check-in templates — chọn theo context
 */
const MORNING_TEMPLATES = {
  has_symptom_worsening: {
    id: 'morning_symptom_worsening',
    vi: 'Triệu chứng {symptom} đang nặng hơn. Hãy cập nhật check-in hôm nay để theo dõi tình trạng.',
    en: 'Your {symptom} seems to be getting worse. Check in today to update your health status.',
  },
  has_symptom_stable: {
    id: 'morning_symptom_stable',
    vi: 'Triệu chứng {symptom} vẫn còn được ghi nhận. Cập nhật check-in để theo dõi thay đổi.',
    en: 'Your {symptom} was recorded recently. Check in to track any changes.',
  },
  has_symptom_improving: {
    id: 'morning_symptom_improving',
    vi: 'Triệu chứng {symptom} đang giảm. Ghi thêm check-in hôm nay để theo dõi tiếp.',
    en: 'Your {symptom} is improving. Check in today to keep tracking it.',
  },
  consecutive_tired: {
    id: 'morning_consecutive_tired',
    vi: '{tiredDays} ngày liên tiếp bạn ghi nhận mệt mỏi. Cập nhật hôm nay để theo dõi thêm.',
    en: 'You\'ve recorded tiredness for {tiredDays} days in a row. Check in today to keep tracking it.',
  },
  streak_good: {
    id: 'morning_streak_good',
    vi: 'Bạn đã ghi nhận sức khỏe ổn định {streakDays} ngày liên tiếp. Tiếp tục cập nhật đều đặn.',
    en: 'You\'ve recorded stable health for {streakDays} days in a row. Keep checking in regularly.',
  },
  high_severity: {
    id: 'morning_high_severity',
    vi: 'Lần trước bạn ghi nhận triệu chứng nặng. Hãy cập nhật tình trạng hôm nay để theo dõi tiếp.',
    en: 'You recorded severe symptoms recently. Update your health status today to keep tracking it.',
  },
  default: {
    id: 'morning_default',
    vi: 'Hôm nay chưa có dữ liệu sức khỏe. Cập nhật trong khoảng 1 phút để theo dõi chính xác hơn.',
    en: 'There is no health data for today yet. Check in now to keep your records up to date.',
  },
};

/**
 * Evening templates
 */
const EVENING_TEMPLATES = {
  has_symptom: {
    id: 'evening_has_symptom',
    vi: 'Triệu chứng {symptom} hôm nay thế nào? Trước khi nghỉ, hãy hoàn tất: {tasks}.',
    en: 'How was your {symptom} today? Before bed, complete: {tasks}.',
  },
  improving: {
    id: 'evening_improving',
    vi: 'Tình trạng hôm nay đã tốt hơn. Trước khi nghỉ, hãy hoàn tất: {tasks}.',
    en: 'Your symptoms improved today. Before bed, complete: {tasks}.',
  },
  default: {
    id: 'evening_default',
    vi: 'Bạn còn thiếu: {tasks}. Hoàn tất trước khi nghỉ để dữ liệu hôm nay đầy đủ.',
    en: 'Still to do: {tasks}. Complete it before bed to finish today\'s record.',
  },
};

/**
 * Afternoon templates
 */
const AFTERNOON_TEMPLATES = {
  has_symptom: {
    id: 'afternoon_has_symptom',
    vi: 'Triệu chứng {symptom} chiều nay thế nào? Nghỉ vài phút và uống nước nếu cần.',
    en: 'How is your {symptom} this afternoon? Take a short break and drink some water if needed.',
  },
  default: {
    id: 'afternoon_default',
    vi: 'Dành vài phút nghỉ ngơi và uống nước trước khi tiếp tục ngày của bạn.',
    en: 'Take a few minutes to rest and drink some water before continuing your day.',
  },
};

/**
 * Context-based alert templates (triggered by events, not time)
 */
const ALERT_TEMPLATES = {
  severity_high: {
    id: 'alert_severity_high',
    vi: '🚨 Triệu chứng {symptom} có mức độ nặng. Bạn nên đi khám để được kiểm tra.',
    en: '🚨 Your {symptom} appears severe. Consider seeing a doctor for an assessment.',
  },
  trend_worsening: {
    id: 'alert_trend_worsening',
    vi: 'Triệu chứng {symptom} có xu hướng nặng hơn. Nếu chưa đỡ, bạn nên đi khám.',
    en: 'Your {symptom} appears to be getting worse. If it does not improve, consider seeing a doctor.',
  },
};

// ─── Template Selection Logic ───────────────────────────────────────────────

/**
 * Chọn morning template phù hợp nhất dựa trên context.
 * Trả về: { template, variables }
 */
function selectMorningTemplate(ctx) {
  // Priority 1: High severity gần đây (chỉ trong 48h, tránh nhắc mãi)
  if (ctx.lastSession && ctx.lastSession.severity === 'high') {
    const sessionAge = ctx.lastSession.created_at
      ? (Date.now() - new Date(ctx.lastSession.created_at).getTime()) / 3600000
      : 999;
    if (sessionAge <= 48) {
      return { template: MORNING_TEMPLATES.high_severity, variables: {} };
    }
  }

  // Priority 2: Nhiều ngày tired liên tiếp
  if (ctx.consecutiveTiredDays >= 2) {
    return {
      template: MORNING_TEMPLATES.consecutive_tired,
      variables: { tiredDays: ctx.consecutiveTiredDays },
    };
  }

  // Priority 3: Streak tốt (ưu tiên hơn symptom stable — user đang tốt thì nên khen)
  if (ctx.streakOkDays >= 3) {
    return {
      template: MORNING_TEMPLATES.streak_good,
      variables: { streakDays: ctx.streakOkDays },
    };
  }

  // Priority 4: Có triệu chứng + trend
  if (ctx.topSymptom) {
    const trend = ctx.topSymptom.trend || 'stable';
    if (trend === 'increasing') {
      return { template: MORNING_TEMPLATES.has_symptom_worsening, variables: { symptom: ctx.topSymptom.display_name } };
    }
    if (trend === 'decreasing') {
      return { template: MORNING_TEMPLATES.has_symptom_improving, variables: { symptom: ctx.topSymptom.display_name } };
    }
    return { template: MORNING_TEMPLATES.has_symptom_stable, variables: { symptom: ctx.topSymptom.display_name } };
  }

  // Default
  return { template: MORNING_TEMPLATES.default, variables: {} };
}

function selectEveningTemplate(ctx, tasks) {
  const taskStr = tasks || '';

  if (ctx.topSymptom && ctx.topSymptom.trend === 'decreasing') {
    return {
      template: EVENING_TEMPLATES.improving,
      variables: { tasks: taskStr },
    };
  }

  if (ctx.topSymptom) {
    return {
      template: EVENING_TEMPLATES.has_symptom,
      variables: { symptom: ctx.topSymptom.display_name, tasks: taskStr },
    };
  }

  return {
    template: EVENING_TEMPLATES.default,
    variables: { tasks: taskStr },
  };
}

function selectAfternoonTemplate(ctx) {
  if (ctx.topSymptom) {
    return {
      template: AFTERNOON_TEMPLATES.has_symptom,
      variables: { symptom: ctx.topSymptom.display_name },
    };
  }
  return { template: AFTERNOON_TEMPLATES.default, variables: {} };
}

// ─── Message Renderer ───────────────────────────────────────────────────────

/**
 * Render template + variables + honorifics → final message string.
 *
 * @param {object} template - { id, vi, en }
 * @param {object} variables - { symptom, tiredDays, ... }
 * @param {object} user - user object with birth_year, gender, display_name, lang
 * @returns {{ text: string, templateId: string }}
 */
function renderMessage(template, variables, user) {
  const lang = user.lang || 'vi';
  const { honorific, selfRef, callName, Honorific, CallName, SelfRef } = getHonorifics(user);

  let text = lang === 'en' ? template.en : template.vi;

  // Replace honorific vars
  text = text.replace(/\{honorific\}/g, honorific);
  text = text.replace(/\{selfRef\}/g, selfRef);
  text = text.replace(/\{callName\}/g, callName);
  text = text.replace(/\{Honorific\}/g, Honorific);
  text = text.replace(/\{CallName\}/g, CallName);
  text = text.replace(/\{SelfRef\}/g, SelfRef);

  // Replace context vars
  for (const [key, val] of Object.entries(variables)) {
    text = text.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val));
  }

  return { text, templateId: template.id };
}

// ─── Main API ───────────────────────────────────────────────────────────────

/**
 * Generate personalized notification message cho 1 user.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {string} triggerType - 'morning' | 'afternoon' | 'evening' | 'alert_severity' | 'alert_trend'
 * @param {object} user - user object (from query)
 * @param {object} [extraVars] - extra template variables (e.g. tasks)
 * @returns {Promise<{ text: string, templateId: string, context: object }>}
 */
async function generateMessage(pool, userId, triggerType, user, extraVars = {}) {
  const ctx = await buildUserContext(pool, userId);

  let selection;
  switch (triggerType) {
    case 'morning':
      selection = selectMorningTemplate(ctx);
      break;
    case 'afternoon':
      selection = selectAfternoonTemplate(ctx);
      break;
    case 'evening':
      selection = selectEveningTemplate(ctx, extraVars.tasks || '');
      break;
    case 'alert_severity':
      selection = {
        template: ALERT_TEMPLATES.severity_high,
        variables: { symptom: ctx.lastSession?.cluster_key || ctx.topSymptom?.display_name || 'triệu chứng' },
      };
      break;
    case 'alert_trend':
      selection = {
        template: ALERT_TEMPLATES.trend_worsening,
        variables: { symptom: ctx.topSymptom?.display_name || 'triệu chứng' },
      };
      break;
    default:
      selection = selectMorningTemplate(ctx);
  }

  // Merge extra variables
  const allVars = { ...selection.variables, ...extraVars };
  const { text, templateId } = renderMessage(selection.template, allVars, user);

  return { text, templateId, context: ctx };
}

/**
 * Kiểm tra có nên gửi context-based alert không.
 * Trả về trigger type hoặc null.
 */
async function checkAlertTriggers(pool, userId) {
  const ctx = await buildUserContext(pool, userId);

  // Trigger 1: Severity cao gần đây
  if (ctx.lastSession && ctx.lastSession.severity === 'high') {
    // Chỉ trigger nếu session trong 24h gần đây
    const hoursAgo = (Date.now() - new Date(ctx.lastSession.created_at).getTime()) / (1000 * 60 * 60);
    if (hoursAgo <= 24) {
      return { trigger: 'alert_severity', context: ctx };
    }
  }

  // Trigger 2: Trend worsening trên cluster chính
  if (ctx.topSymptom && ctx.topSymptom.trend === 'increasing' && ctx.topSymptom.count_7d >= 3) {
    return { trigger: 'alert_trend', context: ctx };
  }

  return null;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  buildUserContext,
  generateMessage,
  renderMessage,
  checkAlertTriggers,
  selectMorningTemplate,
  selectEveningTemplate,
  selectAfternoonTemplate,
  // Export templates for testing
  MORNING_TEMPLATES,
  EVENING_TEMPLATES,
  AFTERNOON_TEMPLATES,
  ALERT_TEMPLATES,
};
