const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { t, getLang } = require('../i18n');
const { createMobileLog, getRecentLogs, getTodayLogs } = require('../controllers/mobile.controller');
const { postChat } = require('../controllers/chat.controller');
const { getMissionsHandler, getMissionHistoryHandler, getMissionStatsHandler } = require('../controllers/missions.controller');
const { upsertOnboardingProfile } = require('../controllers/onboarding.controller');
const { getProfile, updateProfile, deleteAccount, updatePushToken } = require('../controllers/profile.controller');
const { getTreeSummary, getTreeHistory } = require('../controllers/tree.controller');

function mobileRoutes(pool) {
  const router = express.Router();

  // Logs
  router.post('/logs', requireAuth, (req, res) => createMobileLog(pool, req, res));
  router.get('/logs', requireAuth, (req, res) => getRecentLogs(pool, req, res));
  router.get('/logs/recent', requireAuth, (req, res) => getRecentLogs(pool, req, res));
  router.get('/logs/today', requireAuth, (req, res) => getTodayLogs(pool, req, res));

  // Chat
  const multer = require('multer');
  const { getWhisperTranscription } = require('../services/ai/providers/openai');

  const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      cb(null, /\.(m4a|mp3|mp4|wav|webm)$/i.test(file.originalname));
    }
  });

  router.post('/chat/transcribe', requireAuth, (req, res, next) => {
    audioUpload.single('audio')(req, res, (err) => {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No audio file' });
    try {
      const lang = req.headers['accept-language']?.startsWith('en') ? 'en' : 'vi';
      const text = await getWhisperTranscription(req.file.buffer, req.file.originalname, lang);
      return res.status(200).json({ ok: true, text });
    } catch (err) {
      console.error('[transcribe]', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/chat', requireAuth, (req, res) => postChat(pool, req, res));

  // Missions
  router.get('/missions', requireAuth, (req, res) => getMissionsHandler(pool, req, res));
  router.get('/missions/history', requireAuth, (req, res) => getMissionHistoryHandler(pool, req, res));
  router.get('/missions/stats', requireAuth, (req, res) => getMissionStatsHandler(pool, req, res));

  // Onboarding
  router.post('/onboarding', requireAuth, (req, res) => upsertOnboardingProfile(pool, req, res));

  // Profile
  router.get('/profile', requireAuth, (req, res) => getProfile(pool, req, res));
  router.put('/profile', requireAuth, (req, res) => updateProfile(pool, req, res));
  router.delete('/profile', requireAuth, (req, res) => deleteAccount(pool, req, res));
  router.post('/profile/push-token', requireAuth, (req, res) => updatePushToken(pool, req, res));

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
