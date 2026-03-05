const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePremium } = require('../middleware/subscription.middleware');
const voiceService = require('../services/voice.service');

// Lưu file trong memory (không ghi đĩa)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/m4a', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận file audio'), false);
    }
  },
});

function voiceRoutes(pool) {
  const router = express.Router();

  /**
   * POST /api/voice/chat
   * Voice chat — premium only.
   * Body: multipart/form-data { audio: file }
   * Response: { ok, transcript, reply }
   */
  router.post(
    '/chat',
    requireAuth,
    requirePremium(pool),
    upload.single('audio'),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Thiếu file audio' });
      }

      try {
        const { transcript, reply } = await voiceService.voiceChat(
          pool,
          req.user.id,
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname || 'audio.m4a'
        );
        return res.status(200).json({ ok: true, transcript, reply });
      } catch (err) {
        console.error('[voice] chat error:', err);
        return res.status(500).json({ ok: false, error: err.message || 'Lỗi xử lý giọng nói' });
      }
    }
  );

  return router;
}

module.exports = voiceRoutes;
