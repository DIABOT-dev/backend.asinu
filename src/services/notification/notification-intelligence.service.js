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
const { t } = require('../../i18n');
const {
  consecutiveTiredDays,
  readNotificationTopics,
  resolveSymptomLabel,
  topicMetadata,
} = require('./notification-topic.service');

// ─── User Context Builder ───────────────────────────────────────────────────

/**
 * Build full notification context cho 1 user.
 * Gộp dữ liệu từ nhiều bảng → 1 object phẳng.
 */
async function buildUserContext(pool, userId, language = 'vi') {
  const [topics, sessionRes, checkinRes, lifecycleRes, streakRes] = await Promise.all([
    readNotificationTopics(pool, userId, language),
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
      `SELECT session_date::text AS session_date, initial_status, flow_state, triage_summary
       FROM health_checkins
       WHERE user_id = $1
         AND session_date >= DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') - 6
         AND session_date <= DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
       ORDER BY session_date DESC, updated_at DESC, id DESC LIMIT 7`,
      [userId]
    ),
    // Lifecycle
    pool.query(
      `SELECT segment, inactive_days, last_checkin_at FROM user_lifecycle WHERE user_id = $1`,
      [userId]
    ),
    // Streak OK days
    pool
      .query(`SELECT streak_ok_days, risk_tier FROM risk_persistence WHERE user_id = $1`, [userId])
      .catch(() => ({ rows: [] })), // Table might not exist
  ]);

  const topClusters = topics.recentSymptoms;
  const lastSession = sessionRes.rows[0] || null;
  const recentCheckins = checkinRes.rows;
  const lifecycle = lifecycleRes.rows[0] || { segment: 'unknown', inactive_days: 0 };
  const risk = streakRes.rows[0] || { streak_ok_days: 0, risk_tier: null };

  // Derive context
  const topSymptom = topics.topSymptom;
  const lastCheckin = recentCheckins[0] || null;

  return {
    topSymptom, // { cluster_key, display_name, trend, count_7d }
    topCondition: topics.topCondition,
    topClusters, // top 3 clusters
    lastSession, // { severity, needs_doctor, cluster_key }
    lastCheckin, // { session_date, initial_status, triage_summary }
    consecutiveTiredDays: consecutiveTiredDays(recentCheckins),
    lifecycle, // { segment, inactive_days }
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
    key: 'notification.template.morning_symptom_worsening',
  },
  has_symptom_stable: {
    id: 'morning_symptom_stable',
    key: 'notification.template.morning_symptom_stable',
  },
  has_symptom_improving: {
    id: 'morning_symptom_improving',
    key: 'notification.template.morning_symptom_improving',
  },
  consecutive_tired: {
    id: 'morning_consecutive_tired',
    key: 'notification.template.morning_consecutive_tired',
  },
  streak_good: {
    id: 'morning_streak_good',
    key: 'notification.template.morning_streak_good',
  },
  high_severity: {
    id: 'morning_high_severity',
    key: 'notification.template.morning_high_severity',
  },
  has_condition: {
    id: 'morning_has_condition',
    key: 'notification.template.morning_has_condition',
  },
  default: {
    id: 'morning_default',
    key: 'notification.template.morning_default',
  },
};

/**
 * Evening templates
 */
const EVENING_TEMPLATES = {
  has_condition: {
    id: 'evening_has_condition',
    key: 'notification.template.evening_has_condition',
  },
  has_symptom: {
    id: 'evening_has_symptom',
    key: 'notification.template.evening_has_symptom',
  },
  improving: {
    id: 'evening_improving',
    key: 'notification.template.evening_improving',
  },
  default: {
    id: 'evening_default',
    key: 'notification.template.evening_default',
  },
};

/**
 * Afternoon templates
 */
const AFTERNOON_TEMPLATES = {
  has_condition: {
    id: 'afternoon_has_condition',
    key: 'notification.template.afternoon_has_condition',
  },
  has_symptom: {
    id: 'afternoon_has_symptom',
    key: 'notification.template.afternoon_has_symptom',
  },
  default: {
    id: 'afternoon_default',
    key: 'notification.template.afternoon_default',
  },
};

/**
 * Context-based alert templates (triggered by events, not time)
 */
const ALERT_TEMPLATES = {
  severity_high: {
    id: 'alert_severity_high',
    key: 'notification.template.alert_severity_high',
  },
  trend_worsening: {
    id: 'alert_trend_worsening',
    key: 'notification.template.alert_trend_worsening',
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
    if (sessionAge >= 0 && sessionAge <= 48) {
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
      return {
        template: MORNING_TEMPLATES.has_symptom_worsening,
        variables: { symptom: ctx.topSymptom.display_name },
        topic: ctx.topSymptom,
      };
    }
    if (trend === 'decreasing') {
      return {
        template: MORNING_TEMPLATES.has_symptom_improving,
        variables: { symptom: ctx.topSymptom.display_name },
        topic: ctx.topSymptom,
      };
    }
    return {
      template: MORNING_TEMPLATES.has_symptom_stable,
      variables: { symptom: ctx.topSymptom.display_name },
      topic: ctx.topSymptom,
    };
  }

  if (ctx.topCondition) {
    return {
      template: MORNING_TEMPLATES.has_condition,
      variables: { condition: ctx.topCondition.display_name },
      topic: ctx.topCondition,
    };
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
      topic: ctx.topSymptom,
    };
  }

  if (ctx.topSymptom) {
    return {
      template: EVENING_TEMPLATES.has_symptom,
      variables: { symptom: ctx.topSymptom.display_name, tasks: taskStr },
      topic: ctx.topSymptom,
    };
  }

  if (ctx.topCondition) {
    return {
      template: EVENING_TEMPLATES.has_condition,
      variables: { condition: ctx.topCondition.display_name, tasks: taskStr },
      topic: ctx.topCondition,
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
      topic: ctx.topSymptom,
    };
  }
  if (ctx.topCondition) {
    return {
      template: AFTERNOON_TEMPLATES.has_condition,
      variables: { condition: ctx.topCondition.display_name },
      topic: ctx.topCondition,
    };
  }
  return { template: AFTERNOON_TEMPLATES.default, variables: {} };
}

// ─── Message Renderer ───────────────────────────────────────────────────────

/**
 * Render template + variables + honorifics → final message string.
 *
 * @param {object} template - { id, key }
 * @param {object} variables - { symptom, tiredDays, ... }
 * @param {object} user - user object with birth_year, gender, display_name, lang
 * @returns {{ text: string, templateId: string }}
 */
function renderMessage(template, variables, user) {
  const lang = user.lang || 'vi';
  const { honorific, selfRef, callName, Honorific, CallName, SelfRef } = getHonorifics(user);

  const text = t(template.key, lang, {
    honorific,
    selfRef,
    callName,
    Honorific,
    CallName,
    SelfRef,
    ...variables,
  });

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
  const ctx = await buildUserContext(pool, userId, user.lang || 'vi');

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
        variables: {
          symptom: resolveSymptomLabel(ctx.lastSession?.cluster_key, user.lang || 'vi'),
        },
        topic:
          ctx.topClusters.find((topic) => topic.cluster_key === ctx.lastSession?.cluster_key) ||
          null,
      };
      break;
    case 'alert_trend':
      selection = {
        template: ALERT_TEMPLATES.trend_worsening,
        variables: {
          symptom: ctx.topSymptom?.display_name || resolveSymptomLabel(null, user.lang || 'vi'),
        },
        topic: ctx.topSymptom,
      };
      break;
    default:
      selection = selectMorningTemplate(ctx);
  }

  // Merge extra variables
  const allVars = { ...selection.variables, ...extraVars };
  const { text, templateId } = renderMessage(selection.template, allVars, user);

  return { text, templateId, context: ctx, topic: topicMetadata(selection.topic) };
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
    const hoursAgo =
      (Date.now() - new Date(ctx.lastSession.created_at).getTime()) / (1000 * 60 * 60);
    if (hoursAgo >= 0 && hoursAgo <= 24) {
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
