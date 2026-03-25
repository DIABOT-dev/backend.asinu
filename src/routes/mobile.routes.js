const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePremium } = require('../middleware/subscription.middleware');
const { t, getLang } = require('../i18n');
const { createMobileLog, getRecentLogs, getTodayLogs } = require('../controllers/mobile.controller');
const {
  postChat, getChatHistoryHandler, transcribeAudio,
  postChatFeedback, getChatNotes, deleteChatNote, getChatFeedbacks, getChatNotedIds,
} = require('../controllers/chat.controller');
const { getMissionsHandler, getMissionHistoryHandler, getMissionStatsHandler } = require('../controllers/missions.controller');
const { upsertOnboardingProfile, onboardingNext, onboardingComplete, onboardingCompleteV2 } = require('../controllers/onboarding.controller');
const { getProfile, getBasicProfile, updateProfile, deleteAccount, updatePushToken, clearPushToken } = require('../controllers/profile.controller');
const { getTreeSummary, getTreeHistory } = require('../controllers/tree.controller');
const {
  startCheckinHandler, followUpHandler, triageHandler,
  todayCheckinHandler, emergencyHandler,
  pendingAlertsHandler, confirmAlertHandler,
  healthReportHandler, resetTodayHandler, simulateTimePassHandler,
  healthScoreHandler, engagementPatternHandler, engagementOptimalTimeHandler,
} = require('../controllers/checkin.controller');
const { getCaregiverLogs, getCaregiverCheckins, getMemberHealthSummary } = require('../controllers/careCircle.controller');
const { testNotificationHandler } = require('../controllers/notification.controller');

function mobileRoutes(pool) {
  const router = express.Router();

  // Logs
  router.post('/logs', requireAuth, (req, res) => createMobileLog(pool, req, res));
  router.get('/logs', requireAuth, (req, res) => getRecentLogs(pool, req, res));
  router.get('/logs/recent', requireAuth, (req, res) => getRecentLogs(pool, req, res));
  router.get('/logs/today', requireAuth, (req, res) => getTodayLogs(pool, req, res));

  // Caregiver view patient logs (requires can_view_logs permission)
  router.get('/caregiver/logs/:patientId', requireAuth, (req, res) => getCaregiverLogs(pool, req, res));
  router.get('/caregiver/checkins/:patientId', requireAuth, (req, res) => getCaregiverCheckins(pool, req, res));

  // Chat
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
    (req, res) => transcribeAudio(pool, req, res)
  );

  router.post('/chat', requireAuth, (req, res) => postChat(pool, req, res));
  router.get('/chat/history', requireAuth, (req, res) => getChatHistoryHandler(pool, req, res));

  // Chat feedback (like / dislike / note)
  router.post('/chat/feedback', requireAuth, (req, res) => postChatFeedback(pool, req, res));
  router.get('/chat/notes', requireAuth, (req, res) => getChatNotes(pool, req, res));
  router.get('/chat/feedbacks', requireAuth, (req, res) => getChatFeedbacks(pool, req, res));
  router.get('/chat/noted-ids', requireAuth, (req, res) => getChatNotedIds(pool, req, res));
  router.delete('/chat/notes/:id', requireAuth, (req, res) => deleteChatNote(pool, req, res));

  // Missions
  router.get('/missions', requireAuth, (req, res) => getMissionsHandler(pool, req, res));
  router.get('/missions/history', requireAuth, (req, res) => getMissionHistoryHandler(pool, req, res));
  router.get('/missions/stats', requireAuth, (req, res) => getMissionStatsHandler(pool, req, res));

  // Onboarding — legacy form
  router.post('/onboarding', requireAuth, (req, res) => upsertOnboardingProfile(pool, req, res));

  // Onboarding — AI-driven: lấy câu hỏi tiếp theo
  router.post('/onboarding/next', requireAuth, (req, res) => onboardingNext(pool, req, res));

  // Onboarding — AI-driven: lưu profile khi AI báo done
  router.post('/onboarding/complete', requireAuth, (req, res) => onboardingComplete(pool, req, res));

  // Onboarding — V2 fixed 5-page wizard
  router.post('/onboarding/complete-v2', requireAuth, (req, res) => onboardingCompleteV2(pool, req, res));

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
  // DEV-ONLY — blocked in production
  if (process.env.NODE_ENV !== 'production') {
    router.post('/checkin/reset-today',   requireAuth, (req, res) => resetTodayHandler(pool, req, res));
    router.post('/checkin/simulate-time', requireAuth, (req, res) => simulateTimePassHandler(pool, req, res));
    router.post('/test-notification',     requireAuth, (req, res) => testNotificationHandler(pool, req, res));
  }

  // Health Score
  router.get('/health-score', requireAuth, (req, res) => healthScoreHandler(pool, req, res));

  // Engagement patterns
  router.get('/engagement/pattern', requireAuth, (req, res) => engagementPatternHandler(pool, req, res));
  router.get('/engagement/optimal-time', requireAuth, (req, res) => engagementOptimalTimeHandler(pool, req, res));

  // Care Circle Dashboard — caregiver views member's health summary
  router.get('/care-circle/member/:memberId/health-summary', requireAuth, (req, res) => getMemberHealthSummary(pool, req, res));

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
