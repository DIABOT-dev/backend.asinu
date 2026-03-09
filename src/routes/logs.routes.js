/**
 * Logs Routes
 * POST /api/logs/voice-parse — Premium only
 * Nhận audio + log_type, dùng Whisper → GPT-4o trả về parsed health data
 */

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePremium } = require('../middleware/subscription.middleware');
const { parseLogVoice } = require('../services/voice.service');
const { t, getLang } = require('../i18n');
const {
  VOICE_MONTHLY_LIMIT,
  getVoiceUsageThisMonth,
  incrementVoiceUsage,
} = require('../services/subscription.service');

const VALID_LOG_TYPES = ['glucose', 'blood_pressure'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) => {
    const isAudio =
      file.mimetype.startsWith('audio/') ||
      /\.(m4a|mp3|mp4|wav|webm|ogg)$/i.test(file.originalname);
    cb(null, isAudio);
  },
});

function logsRoutes(pool) {
  const router = express.Router();

  /**
   * POST /api/logs/voice-parse
   *
   * Body (multipart/form-data):
   *   audio    — audio file (m4a, mp4, wav, webm...)
   *   log_type — "glucose" | "blood_pressure"
   *
   * Response:
   *   { ok: true,  transcript, parsed: { log_type, value?, context?, systolic?, diastolic?, pulse?, notes? } }
   *   { ok: false, transcript, parsed: null, error: "<Vietnamese message asking user to retry with more info>" }
   */
  router.post(
    '/voice-parse',
    requireAuth,
    requirePremium(pool),
    (req, res, next) => {
      upload.single('audio')(req, res, (err) => {
        if (err) return res.status(400).json({ ok: false, error: err.message });
        next();
      });
    },
    async (req, res) => {
      // Validate audio
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: t('error.missing_audio', getLang(req)) || 'Thiếu file âm thanh.',
        });
      }

      // Validate log_type
      const { log_type } = req.body;
      if (!log_type || !VALID_LOG_TYPES.includes(log_type)) {
        return res.status(400).json({
          ok: false,
          error: `log_type không hợp lệ. Phải là: ${VALID_LOG_TYPES.join(', ')}.`,
        });
      }

      // Check monthly voice limit
      let voiceUsed;
      try {
        voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);
      } catch {
        voiceUsed = 0;
      }

      if (voiceUsed >= VOICE_MONTHLY_LIMIT) {
        return res.status(429).json({
          ok: false,
          code: 'VOICE_LIMIT_EXCEEDED',
          error:
            t('error.voice_limit_exceeded', getLang(req), { limit: VOICE_MONTHLY_LIMIT }) ||
            `Đã đạt giới hạn ${VOICE_MONTHLY_LIMIT} lượt ghi âm tháng này.`,
          voiceUsed,
          voiceLimit: VOICE_MONTHLY_LIMIT,
        });
      }

      try {
        const result = await parseLogVoice(
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname || 'voice_log.m4a',
          log_type
        );

        // Count usage only when audio was actually processed (transcript exists)
        if (result.transcript) {
          try {
            await incrementVoiceUsage(pool, req.user.id);
          } catch { /* non-blocking */ }
        }

        return res.status(200).json(result);
      } catch (err) {
        return res.status(500).json({
          ok: false,
          transcript: '',
          parsed: null,
          error: err.message || 'Xử lý giọng nói thất bại. Vui lòng thử lại sau.',
        });
      }
    }
  );

  return router;
}

module.exports = logsRoutes;
