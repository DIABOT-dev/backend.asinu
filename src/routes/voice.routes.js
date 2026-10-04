const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { handleUpload, verifyAudioMagicBytes } = require('../middleware/upload.middleware');
const { voiceUpload } = require('../middleware/voice-upload.middleware');
const { createVoiceController } = require('../controllers/voice.controller');

function voiceRoutes(pool) {
  const router = express.Router();
  const controller = createVoiceController(pool);

  router.post(
    '/chat',
    requireAuth,
    handleUpload(voiceUpload.single('audio')),
    verifyAudioMagicBytes,
    controller.chat
  );
  router.get('/usage', requireAuth, controller.usage);

  return router;
}

module.exports = voiceRoutes;
