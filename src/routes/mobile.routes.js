const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { chatbotGate } = require('../middleware/chatbot.gate.middleware');
const {
  audioUpload,
  imageUpload,
  handleUpload,
  verifyAudioMagicBytes,
  verifyImageMagicBytes,
} = require('../middleware/upload.middleware');
const { loginByEmail, logoutHandler } = require('../controllers/auth.controller');
const {
  createMobileLog,
  getRecentLogs,
  getTodayLogs,
} = require('../controllers/mobile.controller');
const {
  postChat,
  getChatHistoryHandler,
  transcribeAudio,
  postChatFeedback,
  getChatNotes,
  deleteChatNote,
  getChatFeedbacks,
  getChatNotedIds,
} = require('../controllers/chat.controller');
const {
  getMissionsHandler,
  getMissionHistoryHandler,
  getMissionStatsHandler,
} = require('../controllers/missions.controller');
const {
  upsertOnboardingProfile,
  onboardingNext,
  onboardingComplete,
  onboardingCompleteV2,
} = require('../controllers/onboarding.controller');
const {
  getProfile,
  getBasicProfile,
  updateProfile,
  uploadAvatarHandler,
  deleteAccount,
  updatePushToken,
  clearPushToken,
  featureFlagsHandler,
  changePassword,
} = require('../controllers/profile.controller');
const { getTreeSummary, getTreeHistory } = require('../controllers/tree.controller');
const {
  startCheckinHandler,
  getLocationsHandler,
  followUpHandler,
  triageHandler,
  todayCheckinHandler,
  emergencyHandler,
  pendingAlertsHandler,
  confirmAlertHandler,
  healthReportHandler,
  resetTodayHandler,
  simulateTimePassHandler,
  healthScoreHandler,
  engagementPatternHandler,
  engagementOptimalTimeHandler,
} = require('../controllers/checkin.controller');
const {
  getCaregiverLogs,
  getCaregiverCheckins,
  getMemberHealthSummary,
} = require('../controllers/careCircle.controller');
const { testNotificationHandler } = require('../controllers/notification.controller');
const { trackScreenViewHandler } = require('../controllers/engagement.controller');
const {
  getScriptHandler,
  startScriptHandler,
  answerScriptHandler,
  getSessionHandler,
  createClustersHandler,
} = require('../controllers/script-checkin.controller');

function mobileRoutes(pool) {
  const router = express.Router();

  // Logs
  router.post('/logs', requireAuth, bindController(createMobileLog, pool));
  router.get('/logs', requireAuth, bindController(getRecentLogs, pool));
  router.get('/logs/recent', requireAuth, bindController(getRecentLogs, pool));
  router.get('/logs/today', requireAuth, bindController(getTodayLogs, pool));

  // Caregiver view patient logs (requires can_view_logs permission)
  router.get('/caregiver/logs/:patientId', requireAuth, bindController(getCaregiverLogs, pool));
  router.get(
    '/caregiver/checkins/:patientId',
    requireAuth,
    bindController(getCaregiverCheckins, pool)
  );

  // Chat — gated by chatbot feature flag + daily/monthly limits (MVP audit #1)
  router.post(
    '/chat/transcribe',
    requireAuth,
    chatbotGate(pool),
    handleUpload(audioUpload.single('audio')),
    verifyAudioMagicBytes,
    bindController(transcribeAudio, pool)
  );

  router.post('/chat', requireAuth, chatbotGate(pool), bindController(postChat, pool));
  router.get('/chat/history', requireAuth, bindController(getChatHistoryHandler, pool));

  // Chat feedback (like / dislike / note)
  router.post('/chat/feedback', requireAuth, bindController(postChatFeedback, pool));
  router.get('/chat/notes', requireAuth, bindController(getChatNotes, pool));
  router.get('/chat/feedbacks', requireAuth, bindController(getChatFeedbacks, pool));
  router.get('/chat/noted-ids', requireAuth, bindController(getChatNotedIds, pool));
  router.delete('/chat/notes/:id', requireAuth, bindController(deleteChatNote, pool));

  // Missions
  router.get('/missions', requireAuth, bindController(getMissionsHandler, pool));
  router.get('/missions/history', requireAuth, bindController(getMissionHistoryHandler, pool));
  router.get('/missions/stats', requireAuth, bindController(getMissionStatsHandler, pool));

  // Onboarding — legacy form
  router.post('/onboarding', requireAuth, bindController(upsertOnboardingProfile, pool));

  // Onboarding — AI-driven: lấy câu hỏi tiếp theo
  router.post('/onboarding/next', requireAuth, bindController(onboardingNext, pool));

  // Onboarding — AI-driven: lưu profile khi AI báo done
  router.post('/onboarding/complete', requireAuth, bindController(onboardingComplete, pool));

  // Onboarding — V2 fixed 5-page wizard
  router.post('/onboarding/complete-v2', requireAuth, bindController(onboardingCompleteV2, pool));

  // Profile
  router.get('/profile/basic', requireAuth, bindController(getBasicProfile, pool));
  router.get('/profile', requireAuth, bindController(getProfile, pool));
  router.put('/profile', requireAuth, bindController(updateProfile, pool));
  router.post(
    '/profile/avatar',
    requireAuth,
    handleUpload(imageUpload.single('avatar')),
    verifyImageMagicBytes,
    bindController(uploadAvatarHandler, pool)
  );
  router.delete('/profile', requireAuth, bindController(deleteAccount, pool));
  router.post('/auth/change-password', requireAuth, bindController(changePassword, pool));
  router.post('/profile/push-token', requireAuth, bindController(updatePushToken, pool));
  router.delete('/profile/push-token', requireAuth, bindController(clearPushToken, pool));

  // Health Check-in
  router.get('/checkin/today', requireAuth, bindController(todayCheckinHandler, pool));
  router.get('/checkin/locations', requireAuth, bindController(getLocationsHandler, pool));
  router.post('/checkin/start', requireAuth, bindController(startCheckinHandler, pool));
  router.post('/checkin/followup', requireAuth, bindController(followUpHandler, pool));
  router.post('/checkin/triage', requireAuth, bindController(triageHandler, pool));
  router.post('/checkin/emergency', requireAuth, bindController(emergencyHandler, pool));
  router.get('/checkin/pending-alerts', requireAuth, bindController(pendingAlertsHandler, pool));
  router.post('/checkin/confirm-alert', requireAuth, bindController(confirmAlertHandler, pool));
  router.get('/checkin/report', requireAuth, bindController(healthReportHandler, pool));
  // DEV-ONLY — blocked in production
  if (process.env.NODE_ENV !== 'production') {
    router.post('/checkin/reset-today', requireAuth, bindController(resetTodayHandler, pool));
    router.post(
      '/checkin/simulate-time',
      requireAuth,
      bindController(simulateTimePassHandler, pool)
    );
    router.post('/test-notification', requireAuth, bindController(testNotificationHandler, pool));
  }

  // Script-driven Check-in (new system — 0 AI calls per check-in)
  router.get('/checkin/script', requireAuth, bindController(getScriptHandler, pool));
  router.post('/checkin/script/start', requireAuth, bindController(startScriptHandler, pool));
  router.post('/checkin/script/answer', requireAuth, bindController(answerScriptHandler, pool));
  router.get('/checkin/script/session', requireAuth, bindController(getSessionHandler, pool));
  router.post('/checkin/script/clusters', requireAuth, bindController(createClustersHandler, pool));

  // Health Score
  router.get('/health-score', requireAuth, bindController(healthScoreHandler, pool));

  // Engagement patterns
  router.post('/engagement/screen-view', requireAuth, bindController(trackScreenViewHandler, pool));
  router.get('/engagement/pattern', requireAuth, bindController(engagementPatternHandler, pool));
  router.get(
    '/engagement/optimal-time',
    requireAuth,
    bindController(engagementOptimalTimeHandler, pool)
  );

  // Care Circle Dashboard — caregiver views member's health summary
  router.get(
    '/care-circle/member/:memberId/health-summary',
    requireAuth,
    bindController(getMemberHealthSummary, pool)
  );

  // Tree (Health Score)
  router.get('/tree', requireAuth, bindController(getTreeSummary, pool));
  router.get('/tree/history', requireAuth, bindController(getTreeHistory, pool));

  // Feature Flags (static for now)
  router.get('/flags', requireAuth, bindController(featureFlagsHandler, pool));

  // Auth shortcuts
  router.post('/auth/login', bindController(loginByEmail, pool));
  router.post('/auth/logout', requireAuth, bindController(logoutHandler, pool));

  return router;
}

module.exports = mobileRoutes;
