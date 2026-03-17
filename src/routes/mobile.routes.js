const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { t, getLang } = require('../i18n');
const { createMobileLog, getRecentLogs, getTodayLogs } = require('../controllers/mobile.controller');
const { postChat, getChatHistoryHandler } = require('../controllers/chat.controller');
const { getMissionsHandler, getMissionHistoryHandler, getMissionStatsHandler } = require('../controllers/missions.controller');
const { upsertOnboardingProfile } = require('../controllers/onboarding.controller');
const onboardingAiService = require('../services/onboarding.ai.service');
const onboardingService   = require('../services/onboarding.service');
const { getProfile, getBasicProfile, updateProfile, deleteAccount, updatePushToken, clearPushToken } = require('../controllers/profile.controller');
const { getTreeSummary, getTreeHistory } = require('../controllers/tree.controller');
const {
  startCheckinHandler, followUpHandler, triageHandler,
  todayCheckinHandler, emergencyHandler,
  pendingAlertsHandler, confirmAlertHandler,
  healthReportHandler, resetTodayHandler,
} = require('../controllers/checkin.controller');

function mobileRoutes(pool) {
  const router = express.Router();

  // Logs
  router.post('/logs', requireAuth, (req, res) => createMobileLog(pool, req, res));
  router.get('/logs', requireAuth, (req, res) => getRecentLogs(pool, req, res));
  router.get('/logs/recent', requireAuth, (req, res) => getRecentLogs(pool, req, res));
  router.get('/logs/today', requireAuth, (req, res) => getTodayLogs(pool, req, res));

  // Caregiver view patient logs (requires can_view_logs permission)
  router.get('/caregiver/logs/:patientId', requireAuth, async (req, res) => {
    const caregiverId = req.user.id;
    const patientId = parseInt(req.params.patientId);
    if (!patientId) return res.status(400).json({ ok: false, error: 'Invalid patient ID' });

    try {
      // Check connection exists and has can_view_logs permission
      const { rows: connRows } = await pool.query(
        `SELECT id, permissions FROM user_connections
         WHERE status = 'accepted'
           AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
           AND COALESCE((permissions->>'can_view_logs')::boolean, false) = true`,
        [patientId, caregiverId]
      );
      if (connRows.length === 0) {
        return res.status(403).json({ ok: false, error: 'No permission to view logs' });
      }

      // Fetch patient's recent logs (last 7 days, max 50)
      const { rows: logs } = await pool.query(
        `SELECT lc.id, lc.log_type, lc.occurred_at, lc.note, lc.metadata
         FROM logs_common lc
         WHERE lc.user_id = $1 AND lc.occurred_at > NOW() - INTERVAL '7 days'
         ORDER BY lc.occurred_at DESC
         LIMIT 50`,
        [patientId]
      );

      // Get patient name
      const { rows: patientRows } = await pool.query(
        `SELECT display_name, full_name FROM users WHERE id = $1`,
        [patientId]
      );
      const patientName = patientRows[0]?.display_name || patientRows[0]?.full_name || 'Patient';

      return res.json({ ok: true, patientName, logs });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  // Chat
  const multer = require('multer');
  const { getWhisperTranscription } = require('../services/ai/providers/openai');
  const { requirePremium } = require('../middleware/subscription.middleware');
  const { VOICE_MONTHLY_LIMIT, getVoiceUsageThisMonth, incrementVoiceUsage } = require('../services/subscription.service');

  const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      cb(null, /\.(m4a|mp3|mp4|wav|webm)$/i.test(file.originalname));
    }
  });

  router.post(
    '/chat/transcribe',
    requireAuth,
    (req, res, next) => {
      audioUpload.single('audio')(req, res, (err) => {
        if (err) return res.status(400).json({ ok: false, error: err.message });
        next();
      });
    },
    requirePremium(pool),
    async (req, res) => {
      if (!req.file) return res.status(400).json({ ok: false, error: t('error.missing_audio', getLang(req)) });

      const voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);
      if (voiceUsed >= VOICE_MONTHLY_LIMIT) {
        return res.status(429).json({
          ok: false,
          code: 'VOICE_LIMIT_EXCEEDED',
          error: t('error.voice_limit_exceeded', getLang(req), { limit: VOICE_MONTHLY_LIMIT }),
          voiceUsed,
          voiceLimit: VOICE_MONTHLY_LIMIT,
        });
      }

      try {
        const lang = req.headers['accept-language']?.startsWith('en') ? 'en' : 'vi';
        const text = await getWhisperTranscription(req.file.buffer, req.file.originalname, lang);
        await incrementVoiceUsage(pool, req.user.id);
        return res.status(200).json({ ok: true, text, voiceUsed: voiceUsed + 1, voiceLimit: VOICE_MONTHLY_LIMIT });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    }
  );

  router.post('/chat', requireAuth, (req, res) => postChat(pool, req, res));
  router.get('/chat/history', requireAuth, (req, res) => getChatHistoryHandler(pool, req, res));

  // Chat feedback (like / dislike / note)
  router.post('/chat/feedback', requireAuth, async (req, res) => {
    const { messageId, messageText, feedbackType } = req.body;
    const userId = req.user.id;
    if (!['like', 'dislike', 'note'].includes(feedbackType) || !messageId || !messageText) {
      return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)) });
    }
    try {
      if (feedbackType === 'note') {
        // Prevent duplicate notes for the same message
        const { rows: existing } = await pool.query(
          `SELECT id FROM chat_feedback WHERE user_id=$1 AND message_id=$2 AND feedback_type='note'`,
          [userId, messageId]
        );
        if (existing.length > 0) {
          return res.json({ ok: true, action: 'already_noted' });
        }
        await pool.query(
          `INSERT INTO chat_feedback (user_id, message_id, message_text, feedback_type) VALUES ($1,$2,$3,'note')`,
          [userId, messageId, messageText]
        );
        return res.json({ ok: true, action: 'saved' });
      }
      // like / dislike — toggle or switch
      const { rows } = await pool.query(
        `SELECT id, feedback_type FROM chat_feedback WHERE user_id=$1 AND message_id=$2 AND feedback_type IN ('like','dislike')`,
        [userId, messageId]
      );
      if (rows.length > 0) {
        if (rows[0].feedback_type === feedbackType) {
          await pool.query('DELETE FROM chat_feedback WHERE id=$1', [rows[0].id]);
          return res.json({ ok: true, action: 'removed' });
        }
        await pool.query('UPDATE chat_feedback SET feedback_type=$1, updated_at=NOW() WHERE id=$2', [feedbackType, rows[0].id]);
        return res.json({ ok: true, action: 'updated' });
      }
      await pool.query(
        `INSERT INTO chat_feedback (user_id, message_id, message_text, feedback_type) VALUES ($1,$2,$3,$4)`,
        [userId, messageId, messageText, feedbackType]
      );
      return res.json({ ok: true, action: 'saved' });
    } catch {
      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  });

  router.get('/chat/notes', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, message_text, created_at FROM chat_feedback WHERE user_id=$1 AND feedback_type='note' ORDER BY created_at DESC`,
        [req.user.id]
      );
      return res.json({ ok: true, notes: rows });
    } catch {
      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  });

  // Return list of message_ids that user has noted (for UI state)
  router.get('/chat/noted-ids', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT message_id FROM chat_feedback WHERE user_id=$1 AND feedback_type='note'`,
        [req.user.id]
      );
      return res.json({ ok: true, ids: rows.map(r => r.message_id) });
    } catch {
      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  });

  router.delete('/chat/notes/:id', requireAuth, async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM chat_feedback WHERE id=$1 AND user_id=$2 AND feedback_type='note'`,
        [parseInt(req.params.id), req.user.id]
      );
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  });

  // Missions
  router.get('/missions', requireAuth, (req, res) => getMissionsHandler(pool, req, res));
  router.get('/missions/history', requireAuth, (req, res) => getMissionHistoryHandler(pool, req, res));
  router.get('/missions/stats', requireAuth, (req, res) => getMissionStatsHandler(pool, req, res));

  // Onboarding — legacy form
  router.post('/onboarding', requireAuth, (req, res) => upsertOnboardingProfile(pool, req, res));

  // Onboarding — AI-driven: lấy câu hỏi tiếp theo
  router.post('/onboarding/next', requireAuth, async (req, res) => {
    const { messages = [], language = 'vi' } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)) });
    }
    try {
      const result = await onboardingAiService.getNextQuestion(messages, language);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  });

  // Onboarding — AI-driven: lưu profile khi AI báo done
  router.post('/onboarding/complete', requireAuth, async (req, res) => {
    const { profile } = req.body;
    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)) });
    }
    try {
      const saved = await onboardingService.upsertProfileFromAI(pool, req.user.id, profile);
      return res.status(200).json({ ok: true, profile: saved });
    } catch (err) {
      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  });

  // Onboarding — V2 fixed 5-page wizard
  router.post('/onboarding/complete-v2', requireAuth, async (req, res) => {
    try {
      const { phone } = req.body;
      if (phone && /^0\d{9}$/.test(phone.trim())) {
        const dup = await pool.query(
          'SELECT id FROM users WHERE phone_number = $1 AND id != $2',
          [phone.trim(), req.user.id]
        );
        if (dup.rows.length > 0) {
          return res.status(409).json({ ok: false, error: t('auth.phone_already_used', getLang(req)) });
        }
      }
      const saved = await onboardingService.upsertProfileV2(pool, req.user.id, req.body);
      return res.json({ ok: true, profile: saved });
    } catch (err) {
      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  });

  // Profile
  router.get('/profile/basic', requireAuth, (req, res) => getBasicProfile(pool, req, res));
  router.get('/profile', requireAuth, (req, res) => getProfile(pool, req, res));
  router.put('/profile', requireAuth, (req, res) => updateProfile(pool, req, res));
  router.delete('/profile', requireAuth, (req, res) => deleteAccount(pool, req, res));
  router.post('/profile/push-token', requireAuth, (req, res) => updatePushToken(pool, req, res));
  router.delete('/profile/push-token', requireAuth, (req, res) => clearPushToken(pool, req, res));

  // Health Check-in
  router.get('/checkin/today',     requireAuth, (req, res) => todayCheckinHandler(pool, req, res));
  router.post('/checkin/start',    requireAuth, (req, res) => startCheckinHandler(pool, req, res));
  router.post('/checkin/followup', requireAuth, (req, res) => followUpHandler(pool, req, res));
  router.post('/checkin/triage',          requireAuth, (req, res) => triageHandler(pool, req, res));
  router.post('/checkin/emergency',       requireAuth, (req, res) => emergencyHandler(pool, req, res));
  router.get ('/checkin/pending-alerts',  requireAuth, (req, res) => pendingAlertsHandler(pool, req, res));
  router.post('/checkin/confirm-alert',   requireAuth, (req, res) => confirmAlertHandler(pool, req, res));
  router.get ('/checkin/report',          requireAuth, (req, res) => healthReportHandler(pool, req, res));
  router.post('/checkin/reset-today',    requireAuth, (req, res) => resetTodayHandler(pool, req, res));

  // DEV — Test push notifications
  router.post('/test-notification', requireAuth, async (req, res) => {
    const { sendPushNotification } = require('../services/push.notification.service');
    const { type } = req.body;
    if (!type) return res.status(400).json({ ok: false, error: 'type required' });

    try {
      const { rows } = await pool.query(
        'SELECT push_token FROM users WHERE id = $1', [req.user.id]
      );
      const token = rows[0]?.push_token;
      if (!token) return res.json({ ok: false, error: 'No push_token saved for this user' });

      const NOTIF_MAP = {
        reminder_log_morning:      { title: 'Nhắc nhở buổi sáng',           body: 'Đã đến giờ ghi chỉ số sức khoẻ buổi sáng.' },
        reminder_log_evening:      { title: 'Nhắc nhở buổi tối',            body: 'Đừng quên ghi chỉ số sức khoẻ trước khi ngủ nhé.' },
        reminder_water:            { title: 'Uống nước nào!',               body: 'Đã đến giờ uống nước. Hãy giữ cơ thể luôn đủ nước nhé.' },
        reminder_glucose:          { title: 'Đo đường huyết',               body: 'Đã đến giờ kiểm tra đường huyết.' },
        reminder_bp:               { title: 'Đo huyết áp',                  body: 'Đã đến giờ kiểm tra huyết áp.' },
        reminder_medication_morning:{ title: 'Uống thuốc buổi sáng',        body: 'Nhớ uống thuốc đúng giờ nhé.' },
        reminder_medication_evening:{ title: 'Uống thuốc buổi tối',         body: 'Đừng quên uống thuốc tối nhé.' },
        weekly_recap:              { title: 'Tổng kết tuần',                body: 'Tuần này bạn đã ghi 15 lần log. Rất tuyệt!' },
        engagement:                { title: 'Asinu nhớ bạn!',               body: 'Lâu rồi chưa check-in. Sức khoẻ bạn thế nào?' },
        streak_7:                  { title: 'Chuỗi 7 ngày!',               body: 'Bạn đã log liên tục 7 ngày. Tiếp tục phát huy!' },
        streak_14:                 { title: 'Chuỗi 14 ngày!',              body: 'Tuyệt vời! 14 ngày liên tục.' },
        streak_30:                 { title: 'Chuỗi 30 ngày!',              body: 'Phi thường! 1 tháng liên tục ghi log!' },
        morning_checkin:           { title: 'Check-in sức khoẻ',            body: 'Chào buổi sáng! Hôm nay bạn thấy thế nào?' },
        checkin_followup:          { title: 'Cập nhật sức khoẻ',            body: 'Asinu muốn hỏi thăm tình trạng của bạn.' },
        checkin_followup_urgent:   { title: 'Cần cập nhật',                body: 'Bạn chưa phản hồi. Tình trạng hiện tại thế nào?' },
        emergency:                 { title: 'Khẩn cấp!',                  body: 'Người thân của bạn cần hỗ trợ ngay!' },
        care_circle_invitation:    { title: 'Lời mời Care Circle',          body: 'Nguyễn Văn A đã mời bạn vào nhóm chăm sóc.' },
        care_circle_accepted:      { title: 'Đã chấp nhận',                body: 'Nguyễn Văn B đã tham gia nhóm chăm sóc của bạn.' },
        caregiver_alert:           { title: 'Cảnh báo người thân',         body: 'Người thân của bạn đang cần sự quan tâm.' },
        health_alert:              { title: 'Cảnh báo sức khoẻ',            body: 'Chỉ số đường huyết bất thường được phát hiện.' },
      };

      const notif = NOTIF_MAP[type];
      if (!notif) return res.status(400).json({ ok: false, error: `Unknown type: ${type}` });

      const result = await sendPushNotification(
        [token], notif.title, notif.body, { type }
      );

      // Also save to in-app notifications
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, data) VALUES ($1,$2,$3,$4,$5)`,
        [req.user.id, type, notif.title, notif.body, JSON.stringify({ type, test: true })]
      );

      return res.json({ ok: true, type, title: notif.title, body: notif.body, pushResult: result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Tree (Health Score)
  router.get('/tree', requireAuth, (req, res) => getTreeSummary(pool, req, res));
  router.get('/tree/history', requireAuth, (req, res) => getTreeHistory(pool, req, res));

  // Feature Flags (static for now)
  router.get('/flags', requireAuth, (req, res) => {
    return res.status(200).json({
      FEATURE_MOOD_TRACKER: false,
      FEATURE_JOURNAL: false,
      FEATURE_AUDIO: false,
      FEATURE_DAILY_CHECKIN: true,
      FEATURE_AI_FEED: false,
      FEATURE_AI_CHAT: true
    });
  });

  // Auth shortcuts (redirect to main auth routes pattern)
  router.post('/auth/login', (req, res) => {
    const { loginByEmail } = require('../controllers/auth.controller');
    return loginByEmail(pool, req, res);
  });
  router.post('/auth/phone', (req, res) => {
    const { loginByPhone } = require('../controllers/auth.controller');
    return loginByPhone(pool, req, res);
  });
  router.post('/auth/logout', requireAuth, (req, res) => {
    return res.status(200).json({ ok: true, message: t('success.logged_out', getLang(req)) });
  });

  return router;
}

module.exports = mobileRoutes;
