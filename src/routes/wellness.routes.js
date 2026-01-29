/**
 * Wellness Monitoring Routes
 * API routes cho hệ thống theo dõi sức khỏe
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
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
} = require('../controllers/wellness.controller');

function wellnessRoutes(pool) {
  const router = express.Router();

  // =====================================================
  // USER APIs - Cho user được theo dõi
  // =====================================================

  /**
   * POST /api/wellness/activity
   * Ghi lại hoạt động của user
   * Body: { activity_type, activity_data, session_id }
   * activity_type: APP_OPEN, MOOD_CHECK, HEALTH_MEASUREMENT, QUESTION_ANSWERED, QUESTION_SKIPPED
   */
  router.post('/activity', requireAuth, (req, res) => postActivity(pool, req, res));

  /**
   * GET /api/wellness/state
   * Lấy trạng thái wellness hiện tại
   * Response: { score, status, appOpensToday, streakDays, ... }
   */
  router.get('/state', requireAuth, (req, res) => getState(pool, req, res));

  /**
   * POST /api/wellness/calculate
   * Trigger tính điểm mới (manual)
   * Body: { checkAlert: boolean } (default true)
   */
  router.post('/calculate', requireAuth, (req, res) => postCalculate(pool, req, res));

  /**
   * GET /api/wellness/history
   * Lấy lịch sử điểm wellness
   * Query: ?days=7 (default 7)
   */
  router.get('/history', requireAuth, (req, res) => getHistory(pool, req, res));

  /**
   * GET /api/wellness/summary
   * Lấy tổng hợp hoạt động theo ngày
   * Query: ?days=7 (default 7)
   */
  router.get('/summary', requireAuth, (req, res) => getSummary(pool, req, res));

  /**
   * GET /api/wellness/should-prompt
   * Kiểm tra có nên prompt user không
   * Response: { shouldPrompt, reason, promptType }
   */
  router.get('/should-prompt', requireAuth, (req, res) => checkShouldPrompt(pool, req, res));

  /**
   * GET /api/wellness/alerts
   * User xem các alerts của mình (đã gửi cho người thân)
   * Query: ?status=pending|sent|acknowledged&limit=20
   */
  router.get('/alerts', requireAuth, (req, res) => getMyAlerts(pool, req, res));

  /**
   * POST /api/wellness/help-request
   * User gửi yêu cầu giúp đỡ (alert EMERGENCY đến người thân)
   * Body: { message: "Tôi cần giúp đỡ" } (optional)
   */
  router.post('/help-request', requireAuth, (req, res) => postHelpRequest(pool, req, res));

  // =====================================================
  // CAREGIVER APIs - Cho người thân
  // =====================================================

  /**
   * GET /api/wellness/caregiver/alerts
   * Người thân xem các alerts
   * Query: ?unreadOnly=true&limit=20
   */
  router.get('/caregiver/alerts', requireAuth, (req, res) => getCaregiverAlertsHandler(pool, req, res));

  /**
   * POST /api/wellness/alerts/:id/ack
   * Người thân acknowledge alert
   */
  router.post('/alerts/:id/ack', requireAuth, (req, res) => postAckAlert(pool, req, res));

  return router;
}

module.exports = wellnessRoutes;
