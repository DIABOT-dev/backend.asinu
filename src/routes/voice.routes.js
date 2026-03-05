const express = require('express');
const multer = require('multer');
const { t, getLang } = require('../i18n');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePremium } = require('../middleware/subscription.middleware');
const voiceService = require('../services/voice.service');
const { VOICE_MONTHLY_LIMIT, getVoiceUsageThisMonth, incrementVoiceUsage } = require('../services/subscription.service');

// Lưu file trong memory (không ghi đĩa)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/m4a', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error(t('error.audio_only', 'vi')), false);
    }
  },
});

function voiceRoutes(pool) {
  const router = express.Router();

  /**
   * POST /api/voice/chat
   * Voice chat — premium only, tối đa 5000 lượt/tháng.
   * Body: multipart/form-data { audio: file }
   * Response: { ok, transcript, reply, voiceUsed, voiceLimit }
   */
  router.post(
    '/chat',
    requireAuth,
    requirePremium(pool),
    upload.single('audio'),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: t('error.missing_audio', getLang(req)) });
      }

      // Kiểm tra giới hạn voice tháng này
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
        const { transcript, reply } = await voiceService.voiceChat(
          pool,
          req.user.id,
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname || 'audio.m4a'
        );

        // Tăng counter sau khi xử lý thành công
        await incrementVoiceUsage(pool, req.user.id);

        return res.status(200).json({
          ok: true,
          transcript,
          reply,
          voiceUsed: voiceUsed + 1,
          voiceLimit: VOICE_MONTHLY_LIMIT,
        });
      } catch (err) {
        console.error('[voice] chat error:', err);
        return res.status(500).json({ ok: false, error: err.message || t('error.voice_processing', getLang(req)) });
      }
    }
  );

  /**
   * GET /api/voice/usage
   * Lấy số lượt voice đã dùng tháng này.
   */
  router.get('/usage', requireAuth, requirePremium(pool), async (req, res) => {
    const voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);
    return res.status(200).json({ ok: true, voiceUsed, voiceLimit: VOICE_MONTHLY_LIMIT });
  });

  return router;
}

module.exports = voiceRoutes;
