/**
 * Logs Routes
 * POST /api/logs/voice-parse — Premium only
 * Nhận audio + log_type, dùng Whisper → GPT-4o trả về parsed health data
 */

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePremium } = require('../middleware/subscription.middleware');
const { voiceParse } = require('../controllers/logs.controller');

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
    (req, res) => voiceParse(pool, req, res)
  );

  return router;
}

module.exports = logsRoutes;
