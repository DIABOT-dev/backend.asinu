const express = require('express');
const multer = require('multer');
const { t, getLang } = require('../i18n');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePremium } = require('../middleware/subscription.middleware');
const { voiceChat, getVoiceUsage } = require('../controllers/voice.controller');

// Store file in memory (no disk write)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/m4a', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error(t('error.audio_only', getLang(req))), false);
    }
  },
});

function voiceRoutes(pool) {
  const router = express.Router();

  router.post('/chat', requireAuth, requirePremium(pool), upload.single('audio'), (req, res) => voiceChat(pool, req, res));
  router.get('/usage', requireAuth, requirePremium(pool), (req, res) => getVoiceUsage(pool, req, res));

  return router;
}

module.exports = voiceRoutes;
