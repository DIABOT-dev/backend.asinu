const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { t, getLang } = require('../i18n');
const { createMobileLog, getRecentLogs, getTodayLogs } = require('../controllers/mobile.controller');
const { postChat } = require('../controllers/chat.controller');
const { getMissionsHandler, getMissionHistoryHandler, getMissionStatsHandler } = require('../controllers/missions.controller');
const { upsertOnboardingProfile } = require('../controllers/onboarding.controller');
const onboardingAiService = require('../services/onboarding.ai.service');
const onboardingService   = require('../services/onboarding.service');
const { getProfile, getBasicProfile, updateProfile, deleteAccount, updatePushToken } = require('../controllers/profile.controller');
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

  // Profile
  router.get('/profile/basic', requireAuth, (req, res) => getBasicProfile(pool, req, res));
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
