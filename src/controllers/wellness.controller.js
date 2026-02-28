/**
 * Wellness Monitoring Controller
 * API endpoints cho hệ thống theo dõi sức khỏe
 */

const { t, getLang } = require('../i18n');
const wellnessService = require('../services/wellness.monitoring.service');
const { z } = require('zod');

// =====================================================
// VALIDATION SCHEMAS
// =====================================================

const activitySchema = z.object({
  activity_type: z.enum(['APP_OPEN', 'MOOD_CHECK', 'HEALTH_MEASUREMENT', 'QUESTION_ANSWERED', 'QUESTION_SKIPPED']),
  activity_data: z.record(z.any()).optional().default({}),
  session_id: z.string().optional(),
  occurred_at: z.string().datetime().optional()
});

const sendAlertSchema = z.object({
  alert_type: z.enum(['INFO', 'WARNING', 'URGENT', 'EMERGENCY']),
  title: z.string().min(1),
  message: z.string().min(1),
  context_data: z.record(z.any()).optional()
});

// =====================================================
// 1. LOG ACTIVITY - Ghi lại hoạt động user
// POST /api/wellness/activity
// =====================================================
async function postActivity(pool, req, res) {
  try {
    const parsed = activitySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ 
        ok: false, 
        error: t('error.invalid_data', getLang(req)), 
        details: parsed.error.issues 
      });
    }

    const client = await pool.connect();
    try {
      const activity = await wellnessService.logUserActivity(
        client,
        req.user.id,
        parsed.data.activity_type,
        parsed.data.activity_data,
        parsed.data.session_id
      );

      // Auto-evaluate after activity
      const evaluation = await wellnessService.evaluateUserWellness(pool, req.user.id, {
        executePrompt: false, // Don't auto-prompt from API
        executeAlert: true
      });

      return res.status(200).json({
        ok: true,
        activity,
        evaluation: {
          score: evaluation.score,
          status: evaluation.status,
          statusChanged: evaluation.statusChanged
        }
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('wellness activity failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 2. GET STATE - Lấy trạng thái hiện tại
// GET /api/wellness/state
// =====================================================
async function getState(pool, req, res) {
  try {
    const state = await wellnessService.getWellnessState(pool, req.user.id);
    
    return res.status(200).json({
      ok: true,
      state: {
        score: state?.current_score || 80,
        status: state?.current_status || 'OK',
        lastScoreAt: state?.last_score_at,
        appOpensToday: state?.app_opens_today || 0,
        streakDays: state?.streak_days || 0,
        needsAttention: state?.needs_attention || false,
        consecutiveNoResponse: state?.consecutive_no_response || 0,
        consecutiveNegativeMood: state?.consecutive_negative_mood || 0
      }
    });
  } catch (err) {
    console.error('wellness state failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 3. CALCULATE SCORE - Tính điểm mới (trigger manual)
// POST /api/wellness/calculate
// =====================================================
async function postCalculate(pool, req, res) {
  try {
    const result = await wellnessService.evaluateUserWellness(pool, req.user.id, {
      executePrompt: false,
      executeAlert: req.body.checkAlert !== false
    });

    return res.status(200).json({
      ok: true,
      score: result.score,
      status: result.status,
      breakdown: result.breakdown,
      statusChanged: result.statusChanged,
      alertSent: result.alert ? true : false
    });
  } catch (err) {
    console.error('wellness calculate failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 4. GET HISTORY - Lấy lịch sử điểm
// GET /api/wellness/history?days=7
// =====================================================
async function getHistory(pool, req, res) {
  try {
    const days = parseInt(req.query.days) || 7;
    const history = await wellnessService.getWellnessHistory(pool, req.user.id, days);

    return res.status(200).json({
      ok: true,
      history: history.map(h => ({
        score: h.score,
        status: h.status,
        breakdown: h.score_breakdown,
        calculatedAt: h.calculated_at
      }))
    });
  } catch (err) {
    console.error('wellness history failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 5. GET DAILY SUMMARY - Lấy tổng hợp theo ngày
// GET /api/wellness/summary?days=7
// =====================================================
async function getSummary(pool, req, res) {
  try {
    const days = parseInt(req.query.days) || 7;
    const summaries = await wellnessService.getDailySummaries(pool, req.user.id, days);

    return res.status(200).json({
      ok: true,
      summaries: summaries.map(s => ({
        date: s.summary_date,
        appOpens: s.app_opens,
        moodChecks: s.mood_checks,
        questionsAnswered: s.questions_answered,
        questionsSkipped: s.questions_skipped,
        healthMeasurements: s.health_measurements,
        moodPositive: s.mood_positive,
        moodNeutral: s.mood_neutral,
        moodNegative: s.mood_negative,
        avgGlucose: s.avg_glucose,
        avgBloodPressure: s.avg_blood_pressure_systolic ? {
          systolic: s.avg_blood_pressure_systolic,
          diastolic: s.avg_blood_pressure_diastolic
        } : null,
        avgWeight: s.avg_weight,
        totalWater: s.total_water_ml,
        endOfDayScore: s.end_of_day_score,
        endOfDayStatus: s.end_of_day_status
      }))
    });
  } catch (err) {
    console.error('wellness summary failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 6. CHECK PROMPT - Kiểm tra có nên hỏi không
// GET /api/wellness/should-prompt
// =====================================================
async function checkShouldPrompt(pool, req, res) {
  try {
    const client = await pool.connect();
    try {
      const decision = await wellnessService.shouldPromptUser(client, req.user.id);
      
      return res.status(200).json({
        ok: true,
        shouldPrompt: decision.shouldPrompt,
        reason: decision.reason,
        promptType: decision.promptType
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('wellness prompt check failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 7. GET MY ALERTS - User xem các alert của mình
// GET /api/wellness/alerts
// =====================================================
async function getMyAlerts(pool, req, res) {
  try {
    const alerts = await wellnessService.getCaregiverAlerts(pool, req.user.id, {
      status: req.query.status,
      limit: parseInt(req.query.limit) || 20
    });

    return res.status(200).json({
      ok: true,
      alerts: alerts.map(a => ({
        id: a.id,
        type: a.alert_type,
        status: a.alert_status,
        title: a.title,
        message: a.message,
        triggeredBy: a.triggered_by,
        createdAt: a.created_at,
        sentAt: a.sent_at,
        acknowledgedAt: a.acknowledged_at
      }))
    });
  } catch (err) {
    console.error('wellness get alerts failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 8. GET CAREGIVER ALERTS - Người thân xem alerts
// GET /api/wellness/caregiver/alerts
// =====================================================
async function getCaregiverAlertsHandler(pool, req, res) {
  try {
    const alerts = await wellnessService.getAlertsForCaregiver(pool, req.user.id, {
      unreadOnly: req.query.unreadOnly === 'true',
      limit: parseInt(req.query.limit) || 20
    });

    return res.status(200).json({
      ok: true,
      alerts: alerts.map(a => ({
        id: a.id,
        userId: a.user_id,
        type: a.alert_type,
        status: a.alert_status,
        title: a.title,
        message: a.message,
        contextData: a.context_data,
        triggeredBy: a.triggered_by,
        createdAt: a.created_at,
        sentAt: a.sent_at
      }))
    });
  } catch (err) {
    console.error('wellness caregiver alerts failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 9. ACK ALERT - Người thân acknowledge alert
// POST /api/wellness/alerts/:id/ack
// =====================================================
async function postAckAlert(pool, req, res) {
  try {
    const alertId = parseInt(req.params.id, 10);
    if (isNaN(alertId)) {
      return res.status(400).json({ ok: false, error: t('error.invalid_id', getLang(req)) });
    }

    const result = await wellnessService.ackAlertWithPermission(pool, alertId, req.user.id);

    if (!result.ok) {
      return res.status(result.statusCode || 400).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('wellness ack alert failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// 10. SEND HELP REQUEST - User gửi yêu cầu giúp đỡ
// POST /api/wellness/help-request
// =====================================================
async function postHelpRequest(pool, req, res) {
  try {
    const client = await pool.connect();
    try {
      const lang = getLang(req);
      const alerts = await wellnessService.sendCaregiverAlert(
        client,
        req.user.id,
        'EMERGENCY',
        t('wellness.help_request_title', lang),
        req.body.message || t('wellness.help_request_default', lang),
        'user_request',
        { requestedAt: new Date().toISOString() }
      );

      return res.status(200).json({
        ok: true,
        alertsSent: alerts.length,
        message: alerts.length > 0 
          ? t('wellness.alert_sent', lang) 
          : t('wellness.no_caregiver', lang)
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('wellness help request failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  postActivity,
  getState,
  postCalculate,
  getHistory,
  getSummary,
  checkShouldPrompt,
  getMyAlerts,
  getCaregiverAlertsHandler,
  postAckAlert,
  postHelpRequest
};
