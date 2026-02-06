/**
 * Wellness Monitoring Service
 * Hệ thống theo dõi sức khỏe và thói quen người dùng
 * 
 * Chức năng:
 * 1. Ghi lại hoạt động người dùng (mở app, mood, số đo)
 * 2. Tính điểm wellness 0-100
 * 3. Quyết định có hỏi/thông báo hay không
 * 4. Gửi alert cho người thân khi cần
 */

const { randomUUID } = require('crypto');

// =====================================================
// DEFAULT CONFIG
// =====================================================
const DEFAULT_CONFIG = {
  ok_threshold: 80,
  monitor_threshold: 60,
  concern_threshold: 40,
  prompt_cooldown_minutes: 120,
  max_prompts_per_day: 4,
  alert_after_no_response: 3,
  alert_on_danger: true,
  alert_cooldown_hours: 24,
  weight_consistency: 25,
  weight_mood: 30,
  weight_engagement: 20,
  weight_health_data: 25
};

// Mood values
const MOOD_VALUES = {
  'OK': 100,
  'TIRED': 50,
  'NOT_OK': 20,
  'NORMAL': 80,
  'EMERGENCY': 0
};

// =====================================================
// HELPER FUNCTIONS
// =====================================================

const getToday = () => {
  const now = new Date();
  return now.toISOString().split('T')[0];
};

const minutesSince = (date) => {
  if (!date) return Infinity;
  return Math.floor((Date.now() - new Date(date).getTime()) / 60000);
};

const hoursSince = (date) => {
  if (!date) return Infinity;
  return Math.floor((Date.now() - new Date(date).getTime()) / 3600000);
};

const scoreToStatus = (score, config = DEFAULT_CONFIG) => {
  if (score >= config.ok_threshold) return 'OK';
  if (score >= config.monitor_threshold) return 'MONITOR';
  if (score >= config.concern_threshold) return 'CONCERN';
  return 'DANGER';
};

// =====================================================
// 1. GHI LẠI HOẠT ĐỘNG
// =====================================================

/**
 * Ghi lại một hoạt động của user
 * @param {Object} client - Database client
 * @param {number} userId - User ID
 * @param {string} activityType - APP_OPEN, MOOD_CHECK, HEALTH_MEASUREMENT, QUESTION_ANSWERED, QUESTION_SKIPPED
 * @param {Object} activityData - Chi tiết hoạt động
 * @param {string} sessionId - Session ID (optional)
 */
async function logUserActivity(client, userId, activityType, activityData = {}, sessionId = null) {
  const result = await client.query(
    `INSERT INTO user_activity_logs (user_id, activity_type, activity_data, session_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, activityType, JSON.stringify(activityData), sessionId]
  );

  // Update wellness state based on activity
  await updateWellnessStateFromActivity(client, userId, activityType, activityData);

  return result.rows[0];
}

/**
 * Update wellness state sau mỗi activity
 */
async function updateWellnessStateFromActivity(client, userId, activityType, activityData) {
  const today = getToday();

  // Ensure user has wellness state
  await ensureWellnessState(client, userId);

  switch (activityType) {
    case 'APP_OPEN':
      await client.query(
        `UPDATE user_wellness_state 
         SET app_opens_today = CASE 
           WHEN last_app_open_date = $2 THEN app_opens_today + 1 
           ELSE 1 
         END,
         last_app_open_date = $2,
         streak_days = CASE 
           WHEN last_active_date = $2::date - INTERVAL '1 day' THEN streak_days + 1
           WHEN last_active_date = $2 THEN streak_days
           ELSE 1
         END,
         last_active_date = $2,
         updated_at = NOW()
         WHERE user_id = $1`,
        [userId, today]
      );
      break;

    case 'MOOD_CHECK':
      const mood = activityData.mood || 'NORMAL';
      const isNegative = mood === 'NOT_OK' || mood === 'EMERGENCY';
      
      await client.query(
        `UPDATE user_wellness_state 
         SET last_response_at = NOW(),
         consecutive_no_response = 0,
         consecutive_negative_mood = CASE 
           WHEN $2 THEN consecutive_negative_mood + 1 
           ELSE 0 
         END,
         updated_at = NOW()
         WHERE user_id = $1`,
        [userId, isNegative]
      );
      break;

    case 'QUESTION_ANSWERED':
      await client.query(
        `UPDATE user_wellness_state 
         SET last_response_at = NOW(),
         consecutive_no_response = 0,
         updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      break;

    case 'QUESTION_SKIPPED':
      await client.query(
        `UPDATE user_wellness_state 
         SET consecutive_no_response = consecutive_no_response + 1,
         updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      break;
  }

  // Update daily summary
  await updateDailySummary(client, userId, today, activityType, activityData);
}

/**
 * Ensure user có wellness state
 */
async function ensureWellnessState(client, userId) {
  await client.query(
    `INSERT INTO user_wellness_state (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

/**
 * Ensure user có monitoring config
 */
async function ensureWellnessConfig(client, userId) {
  const result = await client.query(
    `INSERT INTO wellness_monitoring_config (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [userId]
  );
  return result.rows[0] || DEFAULT_CONFIG;
}

/**
 * Update daily summary
 */
async function updateDailySummary(client, userId, date, activityType, activityData) {
  // Ensure daily summary exists
  await client.query(
    `INSERT INTO daily_wellness_summary (user_id, summary_date)
     VALUES ($1, $2)
     ON CONFLICT (user_id, summary_date) DO NOTHING`,
    [userId, date]
  );

  let updateQuery = '';
  let params = [userId, date];

  switch (activityType) {
    case 'APP_OPEN':
      updateQuery = 'app_opens = app_opens + 1';
      break;

    case 'MOOD_CHECK':
      const mood = activityData.mood || 'NORMAL';
      updateQuery = 'mood_checks = mood_checks + 1';
      if (mood === 'OK' || mood === 'NORMAL') {
        updateQuery += ', mood_positive = mood_positive + 1';
      } else if (mood === 'TIRED') {
        updateQuery += ', mood_neutral = mood_neutral + 1';
      } else {
        updateQuery += ', mood_negative = mood_negative + 1';
      }
      break;

    case 'QUESTION_ANSWERED':
      updateQuery = 'questions_answered = questions_answered + 1';
      break;

    case 'QUESTION_SKIPPED':
      updateQuery = 'questions_skipped = questions_skipped + 1';
      break;

    case 'HEALTH_MEASUREMENT':
      updateQuery = 'health_measurements = health_measurements + 1';
      // Update specific measurement averages if provided
      if (activityData.type === 'glucose' && activityData.value) {
        updateQuery = `health_measurements = health_measurements + 1, 
          avg_glucose = COALESCE((avg_glucose + $3) / 2, $3)`;
        params.push(activityData.value);
      } else if (activityData.type === 'blood_pressure' && activityData.systolic) {
        updateQuery = `health_measurements = health_measurements + 1,
          avg_blood_pressure_systolic = COALESCE((avg_blood_pressure_systolic + $3) / 2, $3),
          avg_blood_pressure_diastolic = COALESCE((avg_blood_pressure_diastolic + $4) / 2, $4)`;
        params.push(activityData.systolic, activityData.diastolic);
      } else if (activityData.type === 'weight' && activityData.value) {
        updateQuery = `health_measurements = health_measurements + 1,
          avg_weight = COALESCE((avg_weight + $3) / 2, $3)`;
        params.push(activityData.value);
      } else if (activityData.type === 'water' && activityData.volume_ml) {
        updateQuery = `health_measurements = health_measurements + 1,
          total_water_ml = COALESCE(total_water_ml, 0) + $3`;
        params.push(activityData.volume_ml);
      }
      break;

    default:
      return;
  }

  if (updateQuery) {
    await client.query(
      `UPDATE daily_wellness_summary 
       SET ${updateQuery}, updated_at = NOW()
       WHERE user_id = $1 AND summary_date = $2`,
      params
    );
  }
}

// =====================================================
// 2. TÍNH ĐIỂM WELLNESS (0-100)
// =====================================================

/**
 * Tính điểm wellness cho user
 * Dựa trên: consistency, mood, engagement, health data
 * @returns {Object} { score, status, breakdown }
 */
async function calculateWellnessScore(client, userId) {
  await ensureWellnessState(client, userId);
  const config = await ensureWellnessConfig(client, userId);

  // Get wellness state
  const stateResult = await client.query(
    'SELECT * FROM user_wellness_state WHERE user_id = $1',
    [userId]
  );
  const state = stateResult.rows[0] || {};

  // Get recent activities (last 7 days)
  const activitiesResult = await client.query(
    `SELECT activity_type, activity_data, occurred_at
     FROM user_activity_logs
     WHERE user_id = $1 AND occurred_at >= NOW() - INTERVAL '7 days'
     ORDER BY occurred_at DESC`,
    [userId]
  );
  const activities = activitiesResult.rows;

  // Get recent daily summaries
  const summariesResult = await client.query(
    `SELECT * FROM daily_wellness_summary
     WHERE user_id = $1 AND summary_date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY summary_date DESC`,
    [userId]
  );
  const summaries = summariesResult.rows;

  // Calculate sub-scores
  const consistencyScore = calculateConsistencyScore(state, summaries);
  const moodScore = calculateMoodScore(activities, summaries);
  const engagementScore = calculateEngagementScore(state, activities);
  const healthScore = calculateHealthDataScore(activities, summaries);

  // Weighted average
  const weights = {
    consistency: config.weight_consistency || DEFAULT_CONFIG.weight_consistency,
    mood: config.weight_mood || DEFAULT_CONFIG.weight_mood,
    engagement: config.weight_engagement || DEFAULT_CONFIG.weight_engagement,
    health: config.weight_health_data || DEFAULT_CONFIG.weight_health_data
  };

  const totalWeight = weights.consistency + weights.mood + weights.engagement + weights.health;
  
  const score = Math.round(
    (consistencyScore * weights.consistency +
     moodScore * weights.mood +
     engagementScore * weights.engagement +
     healthScore * weights.health) / totalWeight
  );

  const status = scoreToStatus(score, config);

  const breakdown = {
    consistency: consistencyScore,
    mood: moodScore,
    engagement: engagementScore,
    health: healthScore,
    weights
  };

  // Save score
  const previousScoreResult = await client.query(
    `SELECT score, status FROM user_health_scores 
     WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1`,
    [userId]
  );
  const previousScore = previousScoreResult.rows[0]?.score || null;
  const previousStatus = previousScoreResult.rows[0]?.status || null;

  await client.query(
    `INSERT INTO user_health_scores 
     (user_id, score, status, previous_score, previous_status, score_breakdown, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'activity')`,
    [userId, score, status, previousScore, previousStatus, JSON.stringify(breakdown)]
  );

  // Update current state
  await client.query(
    `UPDATE user_wellness_state 
     SET current_score = $2, current_status = $3, last_score_at = NOW(), updated_at = NOW()
     WHERE user_id = $1`,
    [userId, score, status]
  );

  return { score, status, breakdown, previousScore, previousStatus };
}

/**
 * Tính điểm consistency (đều đặn sử dụng)
 */
function calculateConsistencyScore(state, summaries) {
  let score = 50; // Base score

  // Streak bonus: +5 per day, max +25
  const streakBonus = Math.min(25, (state.streak_days || 0) * 5);
  score += streakBonus;

  // Daily app opens: at least 1 per day = good
  const daysWithActivity = summaries.filter(s => s.app_opens > 0).length;
  const consistencyRate = summaries.length > 0 ? daysWithActivity / summaries.length : 0;
  score += Math.round(consistencyRate * 25);

  return Math.min(100, Math.max(0, score));
}

/**
 * Tính điểm mood
 */
function calculateMoodScore(activities, summaries) {
  // Get mood checks from activities
  const moodChecks = activities.filter(a => a.activity_type === 'MOOD_CHECK');
  
  if (moodChecks.length === 0) {
    // No mood data - neutral score
    return 60;
  }

  let totalMoodValue = 0;
  moodChecks.forEach(check => {
    const mood = check.activity_data?.mood || 'NORMAL';
    totalMoodValue += MOOD_VALUES[mood] || 50;
  });

  return Math.round(totalMoodValue / moodChecks.length);
}

/**
 * Tính điểm engagement (tương tác)
 */
function calculateEngagementScore(state, activities) {
  let score = 50;

  // Penalize consecutive no response
  const noResponsePenalty = Math.min(30, (state.consecutive_no_response || 0) * 10);
  score -= noResponsePenalty;

  // Bonus for answered questions
  const answeredCount = activities.filter(a => a.activity_type === 'QUESTION_ANSWERED').length;
  score += Math.min(30, answeredCount * 5);

  // Bonus for health measurements
  const measurementCount = activities.filter(a => a.activity_type === 'HEALTH_MEASUREMENT').length;
  score += Math.min(20, measurementCount * 3);

  return Math.min(100, Math.max(0, score));
}

/**
 * Tính điểm health data
 */
function calculateHealthDataScore(activities, summaries) {
  // If no health measurements, return neutral
  const measurements = activities.filter(a => a.activity_type === 'HEALTH_MEASUREMENT');
  if (measurements.length === 0) {
    return 70; // Neutral - no negative but room for improvement
  }

  let score = 80; // Start with good score if they're measuring

  // Bonus for regular measurements
  score += Math.min(20, measurements.length * 2);

  return Math.min(100, score);
}

// =====================================================
// 3. QUYẾT ĐỊNH CÓ HỎI KHÔNG
// =====================================================

/**
 * Quyết định có nên prompt user không
 * @returns {Object} { shouldPrompt, reason, promptType }
 */
async function shouldPromptUser(client, userId) {
  await ensureWellnessState(client, userId);
  const config = await ensureWellnessConfig(client, userId);

  // Get current state
  const stateResult = await client.query(
    'SELECT * FROM user_wellness_state WHERE user_id = $1',
    [userId]
  );
  const state = stateResult.rows[0];

  if (!state) {
    return { shouldPrompt: false, reason: 'no_state' };
  }

  // Rule 1: Respect cooldown
  const minutesSinceLastPrompt = minutesSince(state.last_prompt_at);
  if (minutesSinceLastPrompt < (config.prompt_cooldown_minutes || DEFAULT_CONFIG.prompt_cooldown_minutes)) {
    return { shouldPrompt: false, reason: 'cooldown', minutesRemaining: config.prompt_cooldown_minutes - minutesSinceLastPrompt };
  }

  // Rule 2: Check daily limit
  const todayPromptsResult = await client.query(
    `SELECT COUNT(*) as count FROM prompt_history
     WHERE user_id = $1 AND DATE(prompted_at) = CURRENT_DATE`,
    [userId]
  );
  const todayPrompts = parseInt(todayPromptsResult.rows[0]?.count || 0);
  if (todayPrompts >= (config.max_prompts_per_day || DEFAULT_CONFIG.max_prompts_per_day)) {
    return { shouldPrompt: false, reason: 'daily_limit_reached' };
  }

  // Rule 3: If status is OK, don't prompt
  if (state.current_status === 'OK') {
    return { shouldPrompt: false, reason: 'status_ok' };
  }

  // Rule 4: If MONITOR, maybe prompt
  if (state.current_status === 'MONITOR') {
    // Only prompt if been a while since last response
    const minutesSinceResponse = minutesSince(state.last_response_at);
    if (minutesSinceResponse > 240) { // 4 hours
      return { shouldPrompt: true, reason: 'monitor_no_activity', promptType: 'mood_check' };
    }
    return { shouldPrompt: false, reason: 'monitor_recent_activity' };
  }

  // Rule 5: If CONCERN or DANGER, prompt
  if (state.current_status === 'CONCERN' || state.current_status === 'DANGER') {
    return { shouldPrompt: true, reason: 'status_concern', promptType: 'follow_up' };
  }

  return { shouldPrompt: false, reason: 'default_no_prompt' };
}

/**
 * Record a prompt được gửi
 */
async function recordPrompt(client, userId, promptType, promptMessage, triggeredReason) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  const result = await client.query(
    `INSERT INTO prompt_history 
     (user_id, prompt_type, prompt_message, triggered_reason, expired_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, promptType, promptMessage, triggeredReason, expiresAt]
  );

  // Update last prompt time
  await client.query(
    `UPDATE user_wellness_state SET last_prompt_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
    [userId]
  );

  return result.rows[0];
}

// =====================================================
// 4. THÔNG BÁO NGƯỜI THÂN
// =====================================================

/**
 * Quyết định có nên alert người thân không
 * @returns {Object} { shouldAlert, reason, alertType }
 */
async function shouldAlertCaregiver(client, userId) {
  const config = await ensureWellnessConfig(client, userId);

  const stateResult = await client.query(
    'SELECT * FROM user_wellness_state WHERE user_id = $1',
    [userId]
  );
  const state = stateResult.rows[0];

  if (!state) {
    return { shouldAlert: false, reason: 'no_state' };
  }

  // Check cooldown for alerts
  const lastAlertResult = await client.query(
    `SELECT created_at FROM caregiver_alerts 
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const lastAlertAt = lastAlertResult.rows[0]?.created_at;
  const hoursSinceAlert = hoursSince(lastAlertAt);
  
  if (hoursSinceAlert < (config.alert_cooldown_hours || DEFAULT_CONFIG.alert_cooldown_hours)) {
    return { shouldAlert: false, reason: 'alert_cooldown' };
  }

  // Rule 1: User explicitly requested help (handled separately)

  // Rule 2: Multiple no responses
  if (state.consecutive_no_response >= (config.alert_after_no_response || DEFAULT_CONFIG.alert_after_no_response)) {
    return { 
      shouldAlert: true, 
      reason: 'no_response', 
      alertType: 'WARNING',
      message: `${state.consecutive_no_response} lần liên tiếp không có phản hồi.`
    };
  }

  // Rule 3: DANGER status
  if (state.current_status === 'DANGER' && (config.alert_on_danger ?? DEFAULT_CONFIG.alert_on_danger)) {
    return { 
      shouldAlert: true, 
      reason: 'danger_status', 
      alertType: 'URGENT',
      message: 'Mấy hôm nay sinh hoạt khác thường, cần theo dõi.'
    };
  }

  // Rule 4: Multiple consecutive negative mood
  if (state.consecutive_negative_mood >= 3) {
    return { 
      shouldAlert: true, 
      reason: 'negative_mood', 
      alertType: 'WARNING',
      message: 'Mấy ngày gần đây thường xuyên cảm thấy không ổn.'
    };
  }

  return { shouldAlert: false, reason: 'no_alert_needed' };
}

/**
 * Gửi alert đến người thân
 */
async function sendCaregiverAlert(client, userId, alertType, title, message, triggeredBy, contextData = {}) {
  // Find caregivers with can_receive_alerts permission
  const caregiversResult = await client.query(
    `SELECT uc.id as connection_id, 
            CASE WHEN uc.requester_id = $1 THEN uc.addressee_id ELSE uc.requester_id END as caregiver_id
     FROM user_connections uc
     WHERE (uc.requester_id = $1 OR uc.addressee_id = $1)
       AND uc.status = 'accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean, false) = true
     ORDER BY uc.created_at ASC`,
    [userId]
  );

  const alerts = [];

  for (const caregiver of caregiversResult.rows) {
    const result = await client.query(
      `INSERT INTO caregiver_alerts 
       (user_id, caregiver_user_id, connection_id, alert_type, title, message, context_data, triggered_by, alert_status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', NOW())
       RETURNING *`,
      [userId, caregiver.caregiver_id, caregiver.connection_id, alertType, title, message, JSON.stringify(contextData), triggeredBy]
    );
    alerts.push(result.rows[0]);
  }

  // If no caregivers, create pending alert
  if (alerts.length === 0) {
    const result = await client.query(
      `INSERT INTO caregiver_alerts 
       (user_id, alert_type, title, message, context_data, triggered_by, alert_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [userId, alertType, title, message, JSON.stringify(contextData), triggeredBy]
    );
    alerts.push(result.rows[0]);
  }

  // Update wellness state
  await client.query(
    `UPDATE user_wellness_state 
     SET needs_attention = true, attention_reason = $2, updated_at = NOW()
     WHERE user_id = $1`,
    [userId, triggeredBy]
  );

  return alerts;
}

// =====================================================
// 5. MAIN EVALUATION FUNCTION
// =====================================================

/**
 * Evaluate user wellness và quyết định actions
 * Gọi sau mỗi activity hoặc theo schedule
 */
async function evaluateUserWellness(pool, userId, options = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Calculate new score
    const scoreResult = await calculateWellnessScore(client, userId);

    // Check if should prompt
    const promptDecision = await shouldPromptUser(client, userId);

    // Check if should alert caregiver
    const alertDecision = await shouldAlertCaregiver(client, userId);

    const actions = {
      scoreUpdated: true,
      score: scoreResult.score,
      status: scoreResult.status,
      statusChanged: scoreResult.previousStatus && scoreResult.status !== scoreResult.previousStatus,
      prompt: null,
      alert: null
    };

    // Execute prompt if needed
    if (promptDecision.shouldPrompt && options.executePrompt !== false) {
      const promptMessage = promptDecision.promptType === 'mood_check' 
        ? 'Hôm nay bạn cảm thấy thế nào?'
        : 'Bạn có cần hỗ trợ gì không?';
      
      actions.prompt = await recordPrompt(
        client, 
        userId, 
        promptDecision.promptType, 
        promptMessage, 
        promptDecision.reason
      );
    }

    // Execute alert if needed
    if (alertDecision.shouldAlert && options.executeAlert !== false) {
      const stateResult = await client.query(
        'SELECT * FROM user_wellness_state WHERE user_id = $1',
        [userId]
      );
      
      actions.alert = await sendCaregiverAlert(
        client,
        userId,
        alertDecision.alertType,
        alertDecision.alertType === 'URGENT' ? 'Cần chú ý' : 'Thông báo theo dõi',
        alertDecision.message,
        alertDecision.reason,
        {
          score: scoreResult.score,
          status: scoreResult.status,
          state: stateResult.rows[0]
        }
      );
    }

    await client.query('COMMIT');

    return {
      ok: true,
      ...actions,
      breakdown: scoreResult.breakdown,
      promptDecision,
      alertDecision
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =====================================================
// 6. GET FUNCTIONS
// =====================================================

/**
 * Get current wellness state
 */
async function getWellnessState(pool, userId) {
  const client = await pool.connect();
  try {
    await ensureWellnessState(client, userId);
    
    const result = await client.query(
      'SELECT * FROM user_wellness_state WHERE user_id = $1',
      [userId]
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Get wellness history
 */
async function getWellnessHistory(pool, userId, days = 7) {
  const result = await pool.query(
    `SELECT * FROM user_health_scores
     WHERE user_id = $1 AND calculated_at >= NOW() - INTERVAL '${days} days'
     ORDER BY calculated_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get daily summaries
 */
async function getDailySummaries(pool, userId, days = 7) {
  const result = await pool.query(
    `SELECT * FROM daily_wellness_summary
     WHERE user_id = $1 AND summary_date >= CURRENT_DATE - INTERVAL '${days} days'
     ORDER BY summary_date DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get caregiver alerts
 */
async function getCaregiverAlerts(pool, userId, options = {}) {
  let query = `SELECT * FROM caregiver_alerts WHERE user_id = $1`;
  const params = [userId];

  if (options.status) {
    query += ` AND alert_status = $2`;
    params.push(options.status);
  }

  query += ` ORDER BY created_at DESC LIMIT ${options.limit || 20}`;

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get alerts for caregiver (người thân)
 */
async function getAlertsForCaregiver(pool, caregiverUserId, options = {}) {
  let query = `SELECT ca.*, u.phone, u.email
               FROM caregiver_alerts ca
               JOIN users u ON u.id = ca.user_id
               WHERE ca.caregiver_user_id = $1`;
  const params = [caregiverUserId];

  if (options.unreadOnly) {
    query += ` AND ca.alert_status IN ('pending', 'sent')`;
  }

  query += ` ORDER BY ca.created_at DESC LIMIT ${options.limit || 20}`;

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Acknowledge alert
 */
async function acknowledgeAlert(pool, alertId, acknowledgedBy) {
  const result = await pool.query(
    `UPDATE caregiver_alerts 
     SET alert_status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2
     WHERE id = $1
     RETURNING *`,
    [alertId, acknowledgedBy]
  );
  return result.rows[0];
}

// =====================================================
// EXPORTS
// =====================================================

/**
 * Acknowledge alert with permission check
 * @param {Object} pool - Database pool
 * @param {number} alertId - Alert ID
 * @param {number} userId - User acknowledging
 * @returns {Promise<Object>} - { ok, alert, error }
 */
async function ackAlertWithPermission(pool, alertId, userId) {
  try {
    // Get alert
    const alertResult = await pool.query(
      'SELECT * FROM caregiver_alerts WHERE id = $1',
      [alertId]
    );

    if (alertResult.rows.length === 0) {
      return { ok: false, error: 'Không tìm thấy cảnh báo', statusCode: 404 };
    }

    const alert = alertResult.rows[0];

    // Check if user is the caregiver or has permission
    if (alert.caregiver_user_id !== userId) {
      const permissionResult = await pool.query(
        `SELECT id FROM user_connections 
         WHERE status = 'accepted'
           AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
           AND COALESCE((permissions->>'can_ack_escalation')::boolean, false) = true`,
        [alert.user_id, userId]
      );

      if (permissionResult.rows.length === 0) {
        return { ok: false, error: 'Không có quyền truy cập', statusCode: 403 };
      }
    }

    // Acknowledge
    const updated = await acknowledgeAlert(pool, alertId, userId);

    return {
      ok: true,
      alert: {
        id: updated.id,
        status: updated.alert_status,
        acknowledgedAt: updated.acknowledged_at
      }
    };
  } catch (err) {
    console.error('[wellness.monitoring.service] ackAlertWithPermission failed:', err);
    return { ok: false, error: 'Lỗi server' };
  }
}

module.exports = {
  // Activity logging
  logUserActivity,
  updateWellnessStateFromActivity,
  
  // Score calculation
  calculateWellnessScore,
  scoreToStatus,
  
  // Decision making
  shouldPromptUser,
  shouldAlertCaregiver,
  recordPrompt,
  
  // Alert management
  sendCaregiverAlert,
  acknowledgeAlert,
  ackAlertWithPermission,
  
  // Main evaluation
  evaluateUserWellness,
  
  // Getters
  getWellnessState,
  getWellnessHistory,
  getDailySummaries,
  getCaregiverAlerts,
  getAlertsForCaregiver,
  
  // Helpers
  ensureWellnessState,
  ensureWellnessConfig
};
