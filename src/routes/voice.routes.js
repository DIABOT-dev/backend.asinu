const express = require('express');
const multer = require('multer');
const { t, getLang } = require('../i18n');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePremium } = require('../middleware/subscription.middleware');
const { handleUpload } = require('../middleware/upload.middleware');
const { voiceChat, getVoiceUsage } = require('../controllers/voice.controller');

// Voice-specific upload config (10 MB, mimetype-based filtering)
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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

  router.post('/chat', requireAuth, requirePremium(pool), handleUpload(voiceUpload.single('audio')), (req, res) => voiceChat(pool, req, res));
  router.get('/usage', requireAuth, requirePremium(pool), (req, res) => getVoiceUsage(pool, req, res));

  return router;
}

module.exports = voiceRoutes;
