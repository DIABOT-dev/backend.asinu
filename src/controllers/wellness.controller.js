/**
 * Wellness Monitoring Controller
 * API endpoints cho hệ thống theo dõi sức khỏe
 */

const {
  logUserActivity,
  evaluateUserWellness,
  getWellnessState,
  getWellnessHistory,
  getDailySummaries,
  getCaregiverAlerts,
  getAlertsForCaregiver,
  acknowledgeAlert,
  sendCaregiverAlert,
  shouldPromptUser
} = require('../services/wellness.monitoring.service');
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
        error: 'Invalid payload', 
        details: parsed.error.issues 
      });
    }

    const client = await pool.connect();
    try {
      const activity = await logUserActivity(
        client,
        req.user.id,
        parsed.data.activity_type,
        parsed.data.activity_data,
        parsed.data.session_id
      );

      // Auto-evaluate after activity
      const evaluation = await evaluateUserWellness(pool, req.user.id, {
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
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// =====================================================
// 2. GET STATE - Lấy trạng thái hiện tại
// GET /api/wellness/state
// =====================================================
async function getState(pool, req, res) {
  try {
    const state = await getWellnessState(pool, req.user.id);
    
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
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// =====================================================
// 3. CALCULATE SCORE - Tính điểm mới (trigger manual)
// POST /api/wellness/calculate
// =====================================================
async function postCalculate(pool, req, res) {
  try {
    const result = await evaluateUserWellness(pool, req.user.id, {
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
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// =====================================================
// 4. GET HISTORY - Lấy lịch sử điểm
// GET /api/wellness/history?days=7
// =====================================================
async function getHistory(pool, req, res) {
  try {
    const days = parseInt(req.query.days) || 7;
    const history = await getWellnessHistory(pool, req.user.id, days);

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
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// =====================================================
// 5. GET DAILY SUMMARY - Lấy tổng hợp theo ngày
// GET /api/wellness/summary?days=7
// =====================================================
async function getSummary(pool, req, res) {
  try {
    const days = parseInt(req.query.days) || 7;
    const summaries = await getDailySummaries(pool, req.user.id, days);

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
    return res.status(500).json({ ok: false, error: 'Server error' });
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
      const decision = await shouldPromptUser(client, req.user.id);
      
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
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// =====================================================
// 7. GET MY ALERTS - User xem các alert của mình
// GET /api/wellness/alerts
// =====================================================
async function getMyAlerts(pool, req, res) {
  try {
    const alerts = await getCaregiverAlerts(pool, req.user.id, {
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
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// =====================================================
// 8. GET CAREGIVER ALERTS - Người thân xem alerts
// GET /api/wellness/caregiver/alerts
// =====================================================
async function getCaregiverAlertsHandler(pool, req, res) {
  try {
    const alerts = await getAlertsForCaregiver(pool, req.user.id, {
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
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// =====================================================
// 9. ACK ALERT - Người thân acknowledge alert
// POST /api/wellness/alerts/:id/ack
// =====================================================
async function postAckAlert(pool, req, res) {
  try {
    const alertId = req.params.id;
    
    // Verify caregiver has permission
    const alertResult = await pool.query(
      'SELECT * FROM caregiver_alerts WHERE id = $1',
      [alertId]
    );

    if (alertResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Alert not found' });
    }

    const alert = alertResult.rows[0];
    
    // Check if user is the caregiver or has permission
    if (alert.caregiver_user_id !== req.user.id) {
      // Check connection permission
      const permissionResult = await pool.query(
        `SELECT id FROM user_connections 
         WHERE status = 'accepted'
           AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
           AND COALESCE((permissions->>'can_ack_escalation')::boolean, false) = true`,
        [alert.user_id, req.user.id]
      );

      if (permissionResult.rows.length === 0) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }
    }

    const updated = await acknowledgeAlert(pool, alertId, req.user.id);

    return res.status(200).json({
      ok: true,
      alert: {
        id: updated.id,
        status: updated.alert_status,
        acknowledgedAt: updated.acknowledged_at
      }
    });
  } catch (err) {
    console.error('wellness ack alert failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
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
      const alerts = await sendCaregiverAlert(
        client,
        req.user.id,
        'EMERGENCY',
        'Yêu cầu hỗ trợ',
        req.body.message || 'Tôi cần sự giúp đỡ.',
        'user_request',
        { requestedAt: new Date().toISOString() }
      );

      return res.status(200).json({
        ok: true,
        alertsSent: alerts.length,
        message: alerts.length > 0 
          ? 'Đã gửi thông báo đến người thân.' 
          : 'Chưa có người thân được kết nối. Thông báo đã được lưu.'
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('wellness help request failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
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
